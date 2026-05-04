"""
prompt_hook.py — Per-turn prompt injection via Hermes pre_llm_call hook.

Calls prompt.build on the bridge each turn to get phase-specific instructions.
Returns {"context": text} for Hermes to inject into the system prompt.

Also handles:
- USER_GATE structural enforcement: calls message.process when at USER_GATE
- Per-task isolated review: detects taskCompletionInProgress and dispatches
  an isolated reviewer subprocess (same structural guarantee as Claude Code)
- Phase-level isolated review: detects REVIEW state and dispatches the final
  artifact reviewer subprocess before submitting results to the bridge
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from typing import Any

from .types import BridgeClient
from .constants import resolve_reviewer_command
from .workflow_tools import ensure_workflow_session
from .session_projects import (
    get_session_project_dir,
    is_openartisan_project,
    resolve_project_dir,
    set_session_project_dir,
)

logger = logging.getLogger(__name__)

# Timeout for isolated reviewer subprocess (3 minutes)
_DEFAULT_REVIEW_TIMEOUT_S = 180
_REVIEW_FAILURE_PREFIX = "ISOLATED_REVIEW_FAILED:"


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
        try:
            ensure_workflow_session(bridge, session_id, effective_project_dir)
            state = bridge.call("state.get", {"sessionId": session_id})
            if not state or not isinstance(state, dict):
                logger.debug("state.get returned non-dict: %s", type(state).__name__)
                state = {}
            if session_id != "default":
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

            # USER_GATE handling: only robot-artisan auto-approval may
            # synthesize workflow input here. Ordinary Hermes pre-turn hook
            # execution must remain observational so approval eligibility still
            # depends on real user-originated input.
            if (
                state.get("phaseState") == "USER_GATE"
                and state.get("activeAgent") == "robot-artisan"
            ):
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
    try:
        review_prompt = bridge.call("task.getReviewContext", {"sessionId": session_id})
        if not review_prompt or not isinstance(review_prompt, str):
            return

        # Spawn isolated reviewer — fresh process, no conversation history.
        # Omit --model so it inherits the user's default (parent) model.
        review_output = ""
        try:
            result = subprocess.run(
                resolve_reviewer_command(review_prompt),
                capture_output=True,
                cwd=project_dir,
                text=True,
                timeout=_review_timeout_s(),
            )
            returncode = _completed_returncode(result)
            review_output = result.stdout if returncode == 0 else _format_failed_review_output(
                f"reviewer command exited with code {returncode}",
                result.stdout,
                result.stderr,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            logger.warning(
                "Isolated reviewer (claude CLI) not available or timed out: %s", e
            )
            # Graceful degradation: auto-accept to clear the gate.
            # Full implementation review at the end catches issues.
            _auto_accept_review(bridge, session_id, project_dir, str(e))
            return

        if not review_output.strip():
            _auto_accept_review(
                bridge, session_id, project_dir, "Empty reviewer output"
            )
            return

        # Submit review results to bridge
        bridge.call(
            "tool.execute",
            {
                "name": "submit_task_review",
                "args": {"review_output": review_output},
                "context": {"sessionId": session_id, "directory": project_dir},
            },
        )
        logger.info(
            "Per-task review dispatched for task %s",
            state.get("taskCompletionInProgress"),
        )

    except Exception as e:
        logger.warning("Per-task review dispatch failed: %s", e)
        # Graceful degradation: auto-accept to clear the gate
        try:
            _auto_accept_review(bridge, session_id, project_dir, str(e))
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
    def submit_review_result(review_args: dict[str, Any]) -> None:
        result = bridge.call(
            "tool.execute",
            {
                "name": "submit_phase_review",
                "args": review_args,
                "context": {"sessionId": session_id, "directory": project_dir},
            },
        )
        if isinstance(result, str) and result.startswith("Error:"):
            raise RuntimeError(result)

    def submit_review_failure(reason: str) -> None:
        submit_review_result({"review_error": reason})

    try:
        review_prompt = bridge.call("task.getPhaseReviewContext", {"sessionId": session_id})
        if not review_prompt or not isinstance(review_prompt, str):
            submit_review_failure("Phase review context unavailable")
            logger.warning(
                "Phase review context unavailable for %s/%s",
                state.get("phase"),
                state.get("phaseState"),
            )
            return

        try:
            result = subprocess.run(
                resolve_reviewer_command(review_prompt),
                capture_output=True,
                cwd=project_dir,
                text=True,
                timeout=_review_timeout_s(),
            )
            returncode = _completed_returncode(result)
            review_args = {
                "review_stdout": result.stdout,
                "review_stderr": result.stderr,
                "review_exit_code": returncode,
            }
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            logger.warning("Isolated phase reviewer unavailable or timed out: %s", e)
            review_args = {"review_error": str(e)}

        submit_review_result(review_args)
        logger.info(
            "Phase review dispatched for %s/%s",
            state.get("phase"),
            state.get("phaseState"),
        )
    except Exception as e:
        logger.warning("Phase review dispatch failed: %s", e)
        try:
            submit_review_failure(str(e))
        except Exception as inner_e:
            logger.debug("Phase review failure submission also failed: %s", inner_e)


def _auto_accept_review(
    bridge: BridgeClient,
    session_id: str,
    project_dir: str,
    reason: str,
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
            "context": {"sessionId": session_id, "directory": project_dir},
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
        # Set userGateMessageReceived so submit_auto_approve can work
        bridge.call(
            "message.process",
            {
                "sessionId": session_id,
                "parts": [{"type": "text", "text": "(robot-artisan auto-approval)"}],
            },
        )

        approve_prompt = bridge.call(
            "task.getAutoApproveContext", {"sessionId": session_id}
        )
        if not approve_prompt or not isinstance(approve_prompt, str):
            return

        try:
            result = subprocess.run(
                resolve_reviewer_command(approve_prompt),
                capture_output=True,
                cwd=project_dir,
                text=True,
                timeout=120,
            )
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
                "args": {"review_output": approve_output},
                "context": {"sessionId": session_id, "directory": project_dir},
            },
        )
        logger.info("Robot-artisan auto-approval dispatched")

    except Exception as e:
        logger.warning("Auto-approval dispatch failed: %s", e)
