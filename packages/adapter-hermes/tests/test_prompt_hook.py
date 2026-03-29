"""
test_prompt_hook.py — Tests for the pre_llm_call prompt injection hook.

Verifies that prompt.build is called each turn, context is returned
in the correct format, and bridge failures degrade gracefully.
"""
from __future__ import annotations

import pytest

from hermes_adapter.prompt_hook import create_prompt_hook
from hermes_adapter.types import BridgeError

from conftest import MockBridgeClient


# ---------------------------------------------------------------------------
# Normal operation
# ---------------------------------------------------------------------------


class TestPromptHook:
    """pre_llm_call hook calls prompt.build and returns context."""

    def test_returns_context_dict(self, started_bridge):
        """Hook should return {"context": "<prompt text>"}."""
        started_bridge.set_response("prompt.build", "## Phase: PLANNING/DRAFT\nDraft your plan.")
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
        started_bridge.set_response("prompt.build", "## Phase: PLANNING/DRAFT\nCreate your plan.")
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
