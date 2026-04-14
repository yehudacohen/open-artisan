"""
prompt_hook.py — Per-turn prompt injection via Hermes pre_llm_call hook.

Calls prompt.build on the bridge each turn to get phase-specific instructions.
Returns {"context": text} for Hermes to inject into the system prompt.

Also handles:
- USER_GATE structural enforcement: calls message.process when at USER_GATE
- Per-task isolated review: detects taskCompletionInProgress and dispatches
  an isolated reviewer subprocess (same structural guarantee as Claude Code)
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from typing import Any

from .types import BridgeClient

logger = logging.getLogger(__name__)

# Timeout for isolated reviewer subprocess (3 minutes)
_REVIEW_TIMEOUT_S = 180


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
        effective_project_dir = str(kwargs.get("cwd") or project_dir or os.getcwd())
        try:
            bridge.ensure_session(session_id, effective_project_dir)
            state = bridge.call("state.get", {"sessionId": session_id})
            if not state or not isinstance(state, dict):
                logger.debug("state.get returned non-dict: %s", type(state).__name__)
                state = {}

            # Per-task isolated review: dispatch reviewer subprocess
            # when taskCompletionInProgress is set. The reviewer runs in
            # a fresh process with no conversation history (isolation).
            if state.get("taskCompletionInProgress"):
                _dispatch_task_review(bridge, session_id, state, effective_project_dir)

            # USER_GATE handling: either auto-approve (robot-artisan) or
            # signal user message for structural enforcement.
            if state.get("phaseState") == "USER_GATE":
                if state.get("activeAgent") == "robot-artisan":
                    _dispatch_auto_approve(bridge, session_id, effective_project_dir)
                else:
                    bridge.call(
                        "message.process",
                        {
                            "sessionId": session_id,
                            "parts": [
                                {
                                    "type": "text",
                                    "text": "(user message detected via pre_llm_call)",
                                }
                            ],
                        },
                    )
        except Exception:
            logger.debug("State/gate check failed in pre_llm_call hook", exc_info=True)

        # Build the workflow prompt for this turn
        try:
            result = bridge.call("prompt.build", {"sessionId": session_id})
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
                ["claude", "--print", "--max-turns", "1", "-p", review_prompt],
                capture_output=True,
                text=True,
                timeout=_REVIEW_TIMEOUT_S,
            )
            review_output = result.stdout
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
                ["claude", "--print", "--max-turns", "1", "-p", approve_prompt],
                capture_output=True,
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
