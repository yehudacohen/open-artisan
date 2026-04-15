"""
test_prompt_hook.py — Tests for the pre_llm_call prompt injection hook.

Verifies that prompt.build is called each turn, context is returned
in the correct format, and bridge failures degrade gracefully.
"""

from __future__ import annotations

import json
import subprocess
import pytest
from unittest.mock import patch, MagicMock

from hermes_adapter.prompt_hook import (
    create_prompt_hook,
    _dispatch_task_review,
    _auto_accept_review,
)
from hermes_adapter.types import BridgeError

from .conftest import MockBridgeClient


# ---------------------------------------------------------------------------
# Normal operation
# ---------------------------------------------------------------------------


class TestPromptHook:
    """pre_llm_call hook calls prompt.build and returns context."""

    def test_returns_context_dict(self, started_bridge):
        """Hook should return {"context": "<prompt text>"}."""
        started_bridge.set_response(
            "prompt.build", "## Phase: PLANNING/DRAFT\nDraft your plan."
        )
        hook = create_prompt_hook(started_bridge, "test-session")
        result = hook()
        assert isinstance(result, dict)
        assert "context" in result
        assert "PLANNING" in result["context"]

    def test_calls_prompt_build_with_session_id(self, started_bridge):
        """Hook should pass sessionId to prompt.build."""
        started_bridge.set_response("prompt.build", "prompt text")
        hook = create_prompt_hook(started_bridge, "my-session")
        hook()
        calls = started_bridge.get_calls("prompt.build")
        assert len(calls) == 1
        assert calls[0][1]["sessionId"] == "my-session"

    def test_rebuilds_every_call(self, started_bridge):
        """Each call should hit prompt.build (no caching)."""
        call_count = 0

        def counting_response(params):
            nonlocal call_count
            call_count += 1
            return f"prompt v{call_count}"

        started_bridge.set_response_fn("prompt.build", counting_response)
        hook = create_prompt_hook(started_bridge, "s1")
        r1 = hook()
        r2 = hook()
        r3 = hook()
        assert call_count == 3
        assert r1["context"] != r3["context"]

    def test_returns_empty_string_for_none_response(self, started_bridge):
        """If bridge returns None, context should be empty string."""
        started_bridge.set_response("prompt.build", None)
        hook = create_prompt_hook(started_bridge, "s1")
        result = hook()
        assert result == {"context": ""}


# ---------------------------------------------------------------------------
# Bridge failure
# ---------------------------------------------------------------------------


class TestPromptHookBridgeFailure:
    """Bridge failures should not crash the LLM call."""

    def test_returns_empty_context_on_bridge_error(self, started_bridge):
        """BridgeError should be caught — return empty context."""

        def raise_error(params):
            raise BridgeError("subprocess died")

        started_bridge.set_response_fn("prompt.build", raise_error)
        hook = create_prompt_hook(started_bridge, "s1")
        result = hook()
        assert result == {"context": ""}

    def test_returns_empty_context_on_unexpected_error(self, started_bridge):
        """Any exception should be caught — never crash the LLM call."""

        def raise_unexpected(params):
            raise RuntimeError("unexpected")

        started_bridge.set_response_fn("prompt.build", raise_unexpected)
        hook = create_prompt_hook(started_bridge, "s1")
        result = hook()
        assert result == {"context": ""}

    def test_recovers_after_bridge_error(self, started_bridge):
        """After a bridge error, next call should try again (not permanently fail)."""
        call_count = 0

        def flaky_response(params):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise BridgeError("temporary failure")
            return "recovered prompt"

        started_bridge.set_response_fn("prompt.build", flaky_response)
        hook = create_prompt_hook(started_bridge, "s1")
        r1 = hook()  # fails
        assert r1 == {"context": ""}
        r2 = hook()  # recovers
        assert r2["context"] == "recovered prompt"


# ---------------------------------------------------------------------------
# Per-phase content
# ---------------------------------------------------------------------------


class TestPerPhaseContent:
    """Prompt content changes based on workflow phase."""

    def test_planning_prompt_contains_phase(self, started_bridge):
        """PLANNING phase prompt should mention the phase."""
        started_bridge.set_response(
            "prompt.build", "## Phase: PLANNING/DRAFT\nCreate your plan."
        )
        hook = create_prompt_hook(started_bridge, "s1")
        result = hook()
        assert "PLANNING" in result["context"]

    def test_implementation_prompt_contains_task(self, started_bridge):
        """IMPLEMENTATION prompt should include task info."""
        started_bridge.set_response(
            "prompt.build",
            "## Phase: IMPLEMENTATION/DRAFT\nCurrent task: T3 — Build auth module",
        )
        hook = create_prompt_hook(started_bridge, "s1")
        result = hook()
        assert "T3" in result["context"]
        assert "IMPLEMENTATION" in result["context"]


# ---------------------------------------------------------------------------
# USER_GATE detection
# ---------------------------------------------------------------------------


class TestUserGateDetection:
    """Ordinary USER_GATE hook turns remain observational."""

    def test_does_not_call_message_process_at_user_gate_for_normal_sessions(
        self, started_bridge
    ):
        """When state is USER_GATE, ordinary Hermes turns should not fake user input."""
        started_bridge.set_response(
            "state.get", {"phaseState": "USER_GATE", "activeAgent": "artisan"}
        )
        started_bridge.set_response("prompt.build", "prompt text")
        hook = create_prompt_hook(started_bridge, "s1")
        hook()
        msg_calls = started_bridge.get_calls("message.process")
        assert len(msg_calls) == 0

    def test_does_not_call_message_process_at_draft(self, started_bridge):
        """When state is DRAFT, hook should NOT call message.process."""
        started_bridge.set_response("state.get", {"phaseState": "DRAFT"})
        started_bridge.set_response("prompt.build", "prompt text")
        hook = create_prompt_hook(started_bridge, "s1")
        hook()
        msg_calls = started_bridge.get_calls("message.process")
        assert len(msg_calls) == 0

    def test_state_get_failure_does_not_crash(self, started_bridge):
        """If state.get fails, hook should still return prompt context."""

        def raise_error(params):
            raise BridgeError("state failed")

        started_bridge.set_response_fn("state.get", raise_error)
        started_bridge.set_response("prompt.build", "fallback prompt")
        hook = create_prompt_hook(started_bridge, "s1")
        result = hook()
        assert result["context"] == "fallback prompt"


# ---------------------------------------------------------------------------
# Task review dispatch
# ---------------------------------------------------------------------------


class TestTaskReviewDispatch:
    """Hook dispatches isolated reviewer when taskCompletionInProgress is set."""

    def test_calls_task_get_review_context(self, started_bridge):
        """When taskCompletionInProgress is set, should call task.getReviewContext."""
        started_bridge.set_response(
            "state.get", {"taskCompletionInProgress": "T1", "phaseState": "DRAFT"}
        )
        started_bridge.set_response(
            "task.getReviewContext", None
        )  # No prompt = skip dispatch
        started_bridge.set_response("prompt.build", "prompt")
        hook = create_prompt_hook(started_bridge, "s1")
        hook()
        ctx_calls = started_bridge.get_calls("task.getReviewContext")
        assert len(ctx_calls) == 1

    def test_skips_dispatch_when_no_review_pending(self, started_bridge):
        """When taskCompletionInProgress is None, should NOT call task.getReviewContext."""
        started_bridge.set_response(
            "state.get", {"taskCompletionInProgress": None, "phaseState": "DRAFT"}
        )
        started_bridge.set_response("prompt.build", "prompt")
        hook = create_prompt_hook(started_bridge, "s1")
        hook()
        ctx_calls = started_bridge.get_calls("task.getReviewContext")
        assert len(ctx_calls) == 0

    def test_dispatch_failure_does_not_crash_hook(self, started_bridge):
        """If task review dispatch fails, hook should still return prompt."""

        def raise_on_review(params):
            raise BridgeError("review context failed")

        started_bridge.set_response(
            "state.get", {"taskCompletionInProgress": "T1", "phaseState": "DRAFT"}
        )
        started_bridge.set_response_fn("task.getReviewContext", raise_on_review)
        started_bridge.set_response("prompt.build", "still works")
        hook = create_prompt_hook(started_bridge, "s1")
        result = hook()
        assert result["context"] == "still works"


# ---------------------------------------------------------------------------
# _dispatch_task_review subprocess tests
# ---------------------------------------------------------------------------


class TestDispatchTaskReviewSubprocess:
    """Tests for the actual subprocess dispatch path in _dispatch_task_review."""

    def test_successful_dispatch_submits_review(self, started_bridge):
        """On successful subprocess, should call submit_task_review via tool.execute."""
        started_bridge.set_response("task.getReviewContext", "Review prompt here")
        started_bridge.set_response("tool.execute", "Task review passed")
        state = {"taskCompletionInProgress": "T1"}

        mock_result = MagicMock()
        mock_result.stdout = json.dumps(
            {
                "passed": True,
                "issues": [],
                "scores": {"code_quality": 9, "error_handling": 9},
                "reasoning": "All good",
            }
        )

        with patch(
            "hermes_adapter.prompt_hook.subprocess.run", return_value=mock_result
        ):
            _dispatch_task_review(started_bridge, "s1", state, "/tmp/project")

        # Should have called tool.execute with submit_task_review
        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 1
        assert tool_calls[0][1]["name"] == "submit_task_review"
        assert "review_output" in tool_calls[0][1]["args"]

    def test_subprocess_not_found_calls_auto_accept(self, started_bridge):
        """When claude CLI is not found, should call _auto_accept_review."""
        started_bridge.set_response("task.getReviewContext", "Review prompt")
        started_bridge.set_response("tool.execute", "ok")
        state = {"taskCompletionInProgress": "T1"}

        with patch(
            "hermes_adapter.prompt_hook.subprocess.run",
            side_effect=FileNotFoundError("claude not found"),
        ):
            _dispatch_task_review(started_bridge, "s1", state, "/tmp/project")

        # Should have submitted auto-accept via tool.execute
        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 1
        args = tool_calls[0][1]["args"]
        review = json.loads(args["review_output"])
        assert review["passed"] is False
        assert any("dispatch failed" in i.lower() for i in review["issues"])

    def test_subprocess_timeout_calls_auto_accept(self, started_bridge):
        """When subprocess times out, should call _auto_accept_review."""
        started_bridge.set_response("task.getReviewContext", "Review prompt")
        started_bridge.set_response("tool.execute", "ok")
        state = {"taskCompletionInProgress": "T1"}

        with patch(
            "hermes_adapter.prompt_hook.subprocess.run",
            side_effect=subprocess.TimeoutExpired("claude", 180),
        ):
            _dispatch_task_review(started_bridge, "s1", state, "/tmp/project")

        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 1
        review = json.loads(tool_calls[0][1]["args"]["review_output"])
        assert review["passed"] is False

    def test_empty_reviewer_output_calls_auto_accept(self, started_bridge):
        """When reviewer returns empty output, should call _auto_accept_review."""
        started_bridge.set_response("task.getReviewContext", "Review prompt")
        started_bridge.set_response("tool.execute", "ok")
        state = {"taskCompletionInProgress": "T1"}

        mock_result = MagicMock()
        mock_result.stdout = ""

        with patch(
            "hermes_adapter.prompt_hook.subprocess.run", return_value=mock_result
        ):
            _dispatch_task_review(started_bridge, "s1", state, "/tmp/project")

        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 1
        review = json.loads(tool_calls[0][1]["args"]["review_output"])
        assert review["passed"] is False

    def test_no_review_context_skips_dispatch(self, started_bridge):
        """When task.getReviewContext returns None, should skip dispatch entirely."""
        started_bridge.set_response("task.getReviewContext", None)
        state = {"taskCompletionInProgress": "T1"}

        _dispatch_task_review(started_bridge, "s1", state, "/tmp/project")

        # No tool.execute calls — dispatch was skipped
        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 0


# ---------------------------------------------------------------------------
# _auto_accept_review tests
# ---------------------------------------------------------------------------


class TestAutoAcceptReview:
    """Tests for the graceful degradation gate-clearing function."""

    def test_submits_failing_review_to_clear_gate(self, started_bridge):
        """Should submit a review with passed=False to clear taskCompletionInProgress."""
        started_bridge.set_response("tool.execute", "ok")

        _auto_accept_review(
            started_bridge, "s1", "/tmp/project", "subprocess timed out"
        )

        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 1
        params = tool_calls[0][1]
        assert params["name"] == "submit_task_review"
        review = json.loads(params["args"]["review_output"])
        assert review["passed"] is False
        assert review["scores"]["code_quality"] == 0
        assert review["scores"]["error_handling"] == 0
        assert any("subprocess timed out" in i for i in review["issues"])

    def test_passes_correct_context(self, started_bridge):
        """Should pass sessionId and directory in context."""
        started_bridge.set_response("tool.execute", "ok")

        _auto_accept_review(started_bridge, "my-session", "/my/project", "reason")

        params = tool_calls = started_bridge.get_calls("tool.execute")[0][1]
        assert params["context"]["sessionId"] == "my-session"
        assert params["context"]["directory"] == "/my/project"
