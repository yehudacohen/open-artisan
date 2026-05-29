"""
prompt_hook.py — Per-turn prompt injection via Hermes pre_llm_call hook.

Calls prompt.build on the bridge each turn to get phase-specific instructions.
Returns {"context": text} for Hermes to inject into the system prompt.

Also handles:
- USER_GATE structural enforcement: records real user text when Hermes exposes it
- Per-task isolated review: detects taskCompletionInProgress and dispatches
  an isolated reviewer subprocess (same structural guarantee as Claude Code)
- Phase-level isolated review: detects REVIEW state and dispatches the final
  artifact reviewer subprocess before submitting results to the bridge
"""

from __future__ import annotations

import json
import logging
import os
import re
import selectors
import subprocess
import time
from typing import Any

from . import continuation
from .types import BridgeClient
from .constants import resolve_reviewer_command
from .workflow_tools import ensure_workflow_session
from .session_projects import (
    get_session_project_dir,
    has_explicit_session_project,
    is_openartisan_project,
    resolve_project_dir,
    set_last_session_context,
    set_session_project_dir,
    set_last_user_message,
)

logger = logging.getLogger(__name__)

# Hard timeout for isolated reviewer subprocesses. Idle timeout handles stalls;
# this cap prevents progress chatter from making review unbounded.
_DEFAULT_REVIEW_TIMEOUT_S = 900
_DEFAULT_REVIEW_IDLE_TIMEOUT_S = 120
_DEFAULT_IMPLEMENTATION_REVIEW_IDLE_TIMEOUT_S = 600
_REVIEW_SHUTDOWN_GRACE_S = 5
_REVIEW_FAILURE_PREFIX = "ISOLATED_REVIEW_FAILED:"


def _extract_review_token(review_prompt: str) -> str | None:
    match = re.search(r"OPEN_ARTISAN_REVIEW_TOKEN:\s*([a-f0-9]+)", review_prompt, re.I)
    return match.group(1) if match else None


def _review_timeout_s() -> int:
    raw = os.environ.get("OPENARTISAN_REVIEW_TIMEOUT_S")
    if raw is None or not raw.strip():
        return _DEFAULT_REVIEW_TIMEOUT_S
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid OPENARTISAN_REVIEW_TIMEOUT_S=%r; using default", raw)
        return _DEFAULT_REVIEW_TIMEOUT_S
    if value < 30:
        logger.warning("OPENARTISAN_REVIEW_TIMEOUT_S=%s is too low; using default", value)
        return _DEFAULT_REVIEW_TIMEOUT_S
    return value


def _review_idle_timeout_s(phase: str | None = None) -> int:
    raw = os.environ.get("OPENARTISAN_REVIEW_IDLE_TIMEOUT_S")
    default = (
        _DEFAULT_IMPLEMENTATION_REVIEW_IDLE_TIMEOUT_S
        if phase == "IMPLEMENTATION"
        else _DEFAULT_REVIEW_IDLE_TIMEOUT_S
    )
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid OPENARTISAN_REVIEW_IDLE_TIMEOUT_S=%r; using default", raw)
        return default
    if value < 10:
        logger.warning("OPENARTISAN_REVIEW_IDLE_TIMEOUT_S=%s is too low; using default", value)
        return default
    return value


def _run_reviewer_subprocess(prompt: str, project_dir: str, label: str, phase: str | None = None) -> subprocess.CompletedProcess[str]:
    cmd = resolve_reviewer_command(prompt)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=project_dir,
    )
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []
    started = time.monotonic()
    last_progress = started
    idle_timeout = _review_idle_timeout_s(phase)
    hard_timeout = _review_timeout_s()
    selector = selectors.DefaultSelector()
    if proc.stdout is not None:
        os.set_blocking(proc.stdout.fileno(), False)
        selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
    if proc.stderr is not None:
        os.set_blocking(proc.stderr.fileno(), False)
        selector.register(proc.stderr, selectors.EVENT_READ, "stderr")

    def terminate_owned_child(reason: str) -> None:
        try:
            proc.terminate()
            proc.wait(timeout=_REVIEW_SHUTDOWN_GRACE_S)
        except subprocess.TimeoutExpired:
            proc.kill()
        except OSError:
            pass
        raise subprocess.TimeoutExpired(cmd, hard_timeout, output="".join(stdout_parts), stderr=f"{reason}{''.join(stderr_parts)}")

    try:
        while proc.poll() is None:
            now = time.monotonic()
            if now - started >= hard_timeout:
                terminate_owned_child(f"{label} hard timeout after {hard_timeout}s. ")
            if now - last_progress >= idle_timeout:
                terminate_owned_child(f"{label} idle timeout after {idle_timeout}s. ")
            for key, _ in selector.select(timeout=0.1):
                try:
                    raw = os.read(key.fileobj.fileno(), 4096)
                except BlockingIOError:
                    continue
                chunk = raw.decode("utf-8", errors="replace")
                if not chunk:
                    try:
                        selector.unregister(key.fileobj)
                    except Exception:
                        pass
                    continue
                last_progress = time.monotonic()
                if key.data == "stdout":
                    stdout_parts.append(chunk)
                else:
                    stderr_parts.append(chunk)

        for key in list(selector.get_map().values()):
            chunks: list[str] = []
            while True:
                try:
                    raw = os.read(key.fileobj.fileno(), 4096)
                except BlockingIOError:
                    break
                if not raw:
                    break
                chunks.append(raw.decode("utf-8", errors="replace"))
            rest = "".join(chunks)
            if rest:
                if key.data == "stdout":
                    stdout_parts.append(rest)
                else:
                    stderr_parts.append(rest)
        return subprocess.CompletedProcess(cmd, proc.returncode or 0, "".join(stdout_parts), "".join(stderr_parts))
    finally:
        selector.close()


def _format_failed_review_output(reason: str, stdout: str = "", stderr: str = "") -> str:
    details = [reason]
    if isinstance(stdout, str) and stdout.strip():
        details.append(f"stdout: {stdout.strip()}")
    if isinstance(stderr, str) and stderr.strip():
        details.append(f"stderr: {stderr.strip()}")
    return f"{_REVIEW_FAILURE_PREFIX} {' | '.join(details)}"


def _completed_returncode(result: Any) -> int:
    value = getattr(result, "returncode", 0)
    return value if isinstance(value, int) else 0


def _emit_progress(
    bridge: BridgeClient,
    session_id: str,
    *,
    kind: str,
    status: str,
    message: str,
    span_id: str | None = None,
    parent_span_id: str | None = None,
    parent_event_id: str | None = None,
    task_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str | None:
    try:
        result = bridge.call(
            "progress.emit",
            {
                "sessionId": session_id,
                "kind": kind,
                "status": status,
                "message": message,
                **({"spanId": span_id} if span_id else {}),
                **({"parentSpanId": parent_span_id} if parent_span_id else {}),
                **({"parentEventId": parent_event_id} if parent_event_id else {}),
                **({"taskId": task_id} if task_id else {}),
                **({"metadata": metadata} if metadata else {}),
            },
        )
        if isinstance(result, dict) and isinstance(result.get("event"), dict):
            event_id = result["event"].get("id")
            return event_id if isinstance(event_id, str) else None
    except Exception:
        logger.debug("progress.emit failed", exc_info=True)
    return None


def _extract_user_message(kwargs: dict[str, Any]) -> str | None:
    """Best-effort extraction of real user text from Hermes hook kwargs."""
    for key in ("user_message", "user_task", "message", "prompt", "input"):
        value = kwargs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    messages = kwargs.get("messages")
    if isinstance(messages, list):
        for item in reversed(messages):
            if not isinstance(item, dict):
                continue
            if item.get("role") not in {"user", "human"}:
                continue
            content = item.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list):
                parts: list[str] = []
                for part in content:
                    if isinstance(part, dict):
                        text = part.get("text")
                        if isinstance(text, str) and text.strip():
                            parts.append(text.strip())
                if parts:
                    return "\n".join(parts)
    return None


def create_prompt_hook(
    bridge: BridgeClient,
    session_id: str | None = None,
    project_dir: str = ".",
) -> Any:
    """Create the pre_llm_call hook handler.

    The returned callable is registered with Hermes via ctx.register_hook().
    Each invocation:
    1. Checks for pending task review — if so, dispatches isolated reviewer
    2. Checks if at USER_GATE — if so, calls message.process
    3. Calls prompt.build on the bridge
    4. Returns {"context": "<prompt text>"} for system prompt injection

    If the bridge is unreachable, returns {"context": ""} — never crashes
    the LLM call.

    Args:
        bridge: Active bridge client.
        project_dir: Absolute path to the project directory.

    Returns:
        A callable suitable for Hermes pre_llm_call hook registration.
    """

    default_session_id = session_id

    def hook(**kwargs: Any) -> dict[str, str]:
        session_id = str(kwargs.get("session_id") or default_session_id or "default")
        effective_project_dir = resolve_project_dir(
            session_id,
            str(kwargs.get("cwd") or project_dir or os.getcwd()),
        )
        if not get_session_project_dir(session_id):
            if not is_openartisan_project(effective_project_dir):
                return {"context": ""}
            set_session_project_dir(session_id, effective_project_dir)
        workflow_session_id = session_id
        initial_user_message = _extract_user_message(kwargs)
        if initial_user_message:
            set_last_user_message(session_id, initial_user_message)
        set_last_session_context(session_id, continuation.build_session_context(kwargs))
        try:
            ensure_workflow_session(bridge, session_id, effective_project_dir)
            state = bridge.call("state.get", {"sessionId": session_id})
            if not state or not isinstance(state, dict):
                logger.debug("state.get returned non-dict: %s", type(state).__name__)
                state = {}
            if session_id != "default" and not has_explicit_session_project(session_id):
                fallback_state = bridge.call("state.get", {"sessionId": "default"})
                runtime_phase = state.get("phase")
                if (
                    isinstance(fallback_state, dict)
                    and fallback_state.get("phase") != "MODE_SELECT"
                    and (not runtime_phase or runtime_phase == "MODE_SELECT")
                ):
                    workflow_session_id = "default"
                    state = fallback_state

            # Per-task isolated review: dispatch reviewer subprocess
            # when taskCompletionInProgress is set. The reviewer runs in
            # a fresh process with no conversation history (isolation).
            if state.get("taskCompletionInProgress"):
                _dispatch_task_review(bridge, workflow_session_id, state, effective_project_dir)
            elif state.get("phaseState") == "REVIEW":
                dispatch_phase_review(bridge, workflow_session_id, state, effective_project_dir)

            if state.get("phaseState") in {"USER_GATE", "HUMAN_GATE"}:
                user_message = initial_user_message
                if user_message:
                    bridge.call(
                        "message.process",
                        {
                            "sessionId": workflow_session_id,
                            "parts": [{"type": "text", "text": user_message}],
                        },
                    )
                elif state.get("activeAgent") == "robot-artisan":
                    _dispatch_auto_approve(bridge, workflow_session_id, effective_project_dir)
        except Exception:
            logger.debug("State/gate check failed in pre_llm_call hook", exc_info=True)

        # Build the workflow prompt for this turn
        try:
            result = bridge.call("prompt.build", {"sessionId": workflow_session_id})
            if result is None or not isinstance(result, str):
                return {"context": ""}
            return {"context": result}
        except Exception:
            logger.debug("prompt.build failed in pre_llm_call hook", exc_info=True)
            return {"context": ""}

    return hook


def _dispatch_task_review(
    bridge: BridgeClient,
    session_id: str,
    state: dict[str, Any],
    project_dir: str = ".",
) -> None:
    """Dispatch an isolated task review subprocess.

    Calls task.getReviewContext to get the prompt, spawns a subprocess
    (claude --print or similar), and submits the results via submit_task_review.

    Falls back gracefully on failure — the agent can still submit manually.
    """
    review_token: str | None = None
    task_id = str(state.get("taskCompletionInProgress") or state.get("currentTaskId") or "current-task")
    span_id = f"task-review:{task_id}"
    root_event_id = _emit_progress(
        bridge,
        session_id,
        kind="task-review",
        status="started",
        message=f"Per-task review started for {task_id}",
        span_id=span_id,
        task_id=task_id,
    )
    try:
        review_prompt = bridge.call("task.getReviewContext", {"sessionId": session_id})
        if not review_prompt or not isinstance(review_prompt, str):
            _emit_progress(
                bridge,
                session_id,
                kind="task-review",
                status="blocked",
                message=f"Task review context unavailable for {task_id}",
                span_id=span_id,
                parent_event_id=root_event_id,
                task_id=task_id,
            )
            return
        review_token = _extract_review_token(review_prompt)

        # Spawn isolated reviewer — fresh process, no conversation history.
        # Omit --model so it inherits the user's default (parent) model.
        review_output = ""
        try:
            subprocess_event_id = _emit_progress(
                bridge,
                session_id,
                kind="task-review.subprocess",
                status="started",
                message=f"Reviewer subprocess started for {task_id}",
                span_id=f"{span_id}:subprocess",
                parent_span_id=span_id,
                parent_event_id=root_event_id,
                task_id=task_id,
            )
            result = _run_reviewer_subprocess(review_prompt, project_dir, "task-review")
            returncode = _completed_returncode(result)
            if returncode != 0:
                _emit_progress(
                    bridge,
                    session_id,
                    kind="task-review.subprocess",
                    status="failed",
                    message=f"Reviewer subprocess exited with code {returncode} for {task_id}",
                    span_id=f"{span_id}:subprocess",
                    parent_span_id=span_id,
                    parent_event_id=subprocess_event_id or root_event_id,
                    task_id=task_id,
                    metadata={"returncode": returncode},
                )
                _auto_accept_review(
                    bridge,
                    session_id,
                    project_dir,
                    _format_failed_review_output(
                        f"reviewer command exited with code {returncode}",
                        result.stdout,
                        result.stderr,
                    ),
                    review_token,
                )
                return
            review_output = result.stdout
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            logger.warning(
                "Isolated reviewer (claude CLI) not available or timed out: %s", e
            )
            _emit_progress(
                bridge,
                session_id,
                kind="task-review.subprocess",
                status="failed",
                message=f"Reviewer subprocess failed for {task_id}: {e}",
                span_id=f"{span_id}:subprocess",
                parent_span_id=span_id,
                parent_event_id=root_event_id,
                task_id=task_id,
            )
            # Graceful degradation: auto-accept to clear the gate.
            # Full implementation review at the end catches issues.
            _auto_accept_review(bridge, session_id, project_dir, str(e), review_token)
            return

        if not review_output.strip():
            _emit_progress(
                bridge,
                session_id,
                kind="task-review.subprocess",
                status="failed",
                message=f"Reviewer subprocess returned empty output for {task_id}",
                span_id=f"{span_id}:subprocess",
                parent_span_id=span_id,
                parent_event_id=root_event_id,
                task_id=task_id,
            )
            _auto_accept_review(
                bridge, session_id, project_dir, "Empty reviewer output", review_token
            )
            return

        # Submit review results to bridge
        bridge.call(
            "tool.execute",
            {
                "name": "submit_task_review",
                "args": {"review_output": review_output, "review_token": review_token},
                "context": {"sessionId": session_id, "directory": project_dir, "invocation": "isolated-reviewer"},
            },
        )
        _emit_progress(
            bridge,
            session_id,
            kind="task-review",
            status="succeeded",
            message=f"Per-task review submitted for {task_id}",
            span_id=span_id,
            parent_event_id=root_event_id,
            task_id=task_id,
        )
        logger.info(
            "Per-task review dispatched for task %s",
            state.get("taskCompletionInProgress"),
        )

    except Exception as e:
        logger.warning("Per-task review dispatch failed: %s", e)
        _emit_progress(
            bridge,
            session_id,
            kind="task-review",
            status="failed",
            message=f"Per-task review dispatch failed for {task_id}: {e}",
            span_id=span_id,
            parent_event_id=root_event_id,
            task_id=task_id,
        )
        # Graceful degradation: auto-accept to clear the gate
        try:
            _auto_accept_review(bridge, session_id, project_dir, str(e), review_token)
        except Exception as inner_e:
            logger.debug("Auto-accept fallback also failed: %s", inner_e)


def dispatch_phase_review(
    bridge: BridgeClient,
    session_id: str,
    state: dict[str, Any],
    project_dir: str = ".",
) -> None:
    """Dispatch an isolated phase-level review subprocess.

    This is the final artifact review path for bridge/Hermes workflows. The
    authoring agent must not self-submit criteria for phase approval.
    """
    review_token: str | None = None
    phase = str(state.get("phase") or "current-phase")
    span_id = f"phase-review:{phase}"
    root_event_id = _emit_progress(
        bridge,
        session_id,
        kind="phase-review",
        status="started",
        message=f"Phase review started for {phase}",
        span_id=span_id,
    )

    def submit_review_result(review_args: dict[str, Any]) -> None:
        if not review_token:
            raise RuntimeError("Phase review token unavailable; request fresh review context")
        result = bridge.call(
            "tool.execute",
            {
                "name": "submit_phase_review",
                "args": {**review_args, "review_token": review_token},
                "context": {"sessionId": session_id, "directory": project_dir, "invocation": "isolated-reviewer"},
            },
        )
        if isinstance(result, str) and result.startswith("Error:"):
            raise RuntimeError(result)

    def submit_review_failure(reason: str) -> None:
        submit_review_result({"review_error": reason})

    try:
        review_prompt = bridge.call("task.getPhaseReviewContext", {"sessionId": session_id})
        if not review_prompt or not isinstance(review_prompt, str):
            logger.warning(
                "Phase review context unavailable for %s/%s",
                state.get("phase"),
                state.get("phaseState"),
            )
            _emit_progress(
                bridge,
                session_id,
                kind="phase-review",
                status="blocked",
                message=f"Phase review context unavailable for {phase}",
                span_id=span_id,
                parent_event_id=root_event_id,
            )
            return
        review_token = _extract_review_token(review_prompt)
        if not review_token:
            logger.warning("Phase review context did not include a review token")
            _emit_progress(
                bridge,
                session_id,
                kind="phase-review",
                status="blocked",
                message=f"Phase review token unavailable for {phase}",
                span_id=span_id,
                parent_event_id=root_event_id,
            )
            return

        try:
            subprocess_event_id = _emit_progress(
                bridge,
                session_id,
                kind="phase-review.subprocess",
                status="started",
                message=f"Phase reviewer subprocess started for {phase}",
                span_id=f"{span_id}:subprocess",
                parent_span_id=span_id,
                parent_event_id=root_event_id,
            )
            result = _run_reviewer_subprocess(review_prompt, project_dir, "phase-review", phase)
            returncode = _completed_returncode(result)
            review_args = {
                "review_stdout": result.stdout,
                "review_stderr": result.stderr,
                "review_exit_code": returncode,
            }
            _emit_progress(
                bridge,
                session_id,
                kind="phase-review.subprocess",
                status="succeeded" if returncode == 0 else "failed",
                message=f"Phase reviewer subprocess exited with code {returncode} for {phase}",
                span_id=f"{span_id}:subprocess",
                parent_span_id=span_id,
                parent_event_id=subprocess_event_id or root_event_id,
                metadata={"returncode": returncode},
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            logger.warning("Isolated phase reviewer unavailable or timed out: %s", e)
            review_args = {"review_error": str(e)}
            _emit_progress(
                bridge,
                session_id,
                kind="phase-review.subprocess",
                status="failed",
                message=f"Phase reviewer subprocess failed for {phase}: {e}",
                span_id=f"{span_id}:subprocess",
                parent_span_id=span_id,
                parent_event_id=root_event_id,
            )

        submit_review_result(review_args)
        _emit_progress(
            bridge,
            session_id,
            kind="phase-review",
            status="succeeded",
            message=f"Phase review submitted for {phase}",
            span_id=span_id,
            parent_event_id=root_event_id,
        )
        logger.info(
            "Phase review dispatched for %s/%s",
            state.get("phase"),
            state.get("phaseState"),
        )
    except Exception as e:
        logger.warning("Phase review dispatch failed: %s", e)
        _emit_progress(
            bridge,
            session_id,
            kind="phase-review",
            status="failed",
            message=f"Phase review dispatch failed for {phase}: {e}",
            span_id=span_id,
            parent_event_id=root_event_id,
        )
        if not review_token:
            logger.debug("Cannot submit phase review failure without a review token")
            return
        try:
            submit_review_failure(str(e))
        except Exception as inner_e:
            logger.debug("Phase review failure submission also failed: %s", inner_e)


def _auto_accept_review(
    bridge: BridgeClient,
    session_id: str,
    project_dir: str,
    reason: str,
    review_token: str | None = None,
) -> None:
    """Clear a pending task review gate on dispatch failure.

    Submits a review with zero quality scores. The quality score override
    in parseTaskReviewResult will set passed=false, reverting the task to
    pending — but critically, taskCompletionInProgress gets cleared so
    the agent isn't permanently stuck. The agent will see the task is
    still pending and can re-attempt mark_task_complete.
    """
    bridge.call(
        "tool.execute",
        {
            "name": "submit_task_review",
            "args": {
                **({"review_token": review_token} if review_token else {}),
                "review_output": json.dumps(
                    {
                        "passed": False,
                        "issues": [f"Review dispatch failed: {reason}"],
                        "scores": {"code_quality": 0, "error_handling": 0},
                        "reasoning": "Graceful degradation: reviewer subprocess failed. "
                        "Task reverted to pending — full implementation review will catch issues.",
                    }
                ),
            },
            "context": {"sessionId": session_id, "directory": project_dir, "invocation": "isolated-reviewer"},
        },
    )


def _dispatch_auto_approve(
    bridge: BridgeClient,
    session_id: str,
    project_dir: str,
) -> None:
    """Dispatch an isolated auto-approver for robot-artisan mode at USER_GATE.

    Calls task.getAutoApproveContext for the prompt, spawns claude --print,
    submits via submit_auto_approve. Falls back gracefully — if auto-approval
    fails, the agent proceeds as normal at USER_GATE.
    """
    try:
        approve_prompt = bridge.call(
            "task.getAutoApproveContext", {"sessionId": session_id}
        )
        if not approve_prompt or not isinstance(approve_prompt, str):
            return
        approve_token = _extract_review_token(approve_prompt)
        if not approve_token:
            return

        try:
            result = _run_reviewer_subprocess(approve_prompt, project_dir, "auto-approve")
            approve_output = result.stdout
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            logger.warning("Auto-approve subprocess failed: %s", e)
            return

        if not approve_output.strip():
            return

        bridge.call(
            "tool.execute",
            {
                "name": "submit_auto_approve",
                "args": {"review_output": approve_output, "review_token": approve_token},
                "context": {"sessionId": session_id, "directory": project_dir, "invocation": "auto-approver"},
            },
        )
        logger.info("Robot-artisan auto-approval dispatched")

    except Exception as e:
        logger.warning("Auto-approval dispatch failed: %s", e)
