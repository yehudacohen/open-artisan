"""
test_integration.py — Integration tests for the Hermes adapter.

Tests the full flow: session start → tool registration → mode selection →
guard enforcement → phase progression. Also tests resume after crash.
"""

from __future__ import annotations

import json
import pytest
from unittest.mock import AsyncMock

from hermes_adapter import register, _on_session_start, _on_session_end
from hermes_adapter.workflow_tools import register_workflow_tools
from hermes_adapter.guard_wrappers import register_guard_wrappers, _guarded_handler
from hermes_adapter.prompt_hook import create_prompt_hook
from hermes_adapter.constants import WORKFLOW_TOOLS, GUARDED_TOOLS, TOOLSET_NAME
from hermes_adapter.types import BridgeError

from .conftest import MockBridgeClient, MockHermesContext


# ---------------------------------------------------------------------------
# Full registration flow
# ---------------------------------------------------------------------------


class TestFullRegistration:
    """register(ctx) wires everything together."""

    def test_register_creates_all_tools(self, mock_ctx, mock_bridge):
        """After register(), all workflow + guard wrapper tools should exist."""
        # Set up original handlers for guard wrappers
        for tool_name in GUARDED_TOOLS:
            mock_ctx.set_original_handler(tool_name, AsyncMock(return_value="ok"))

        register_workflow_tools(mock_ctx, mock_bridge)
        register_guard_wrappers(mock_ctx, mock_bridge)

        # Check workflow tools (13 + oa_state = 14)
        for hermes_name, _, _, _ in WORKFLOW_TOOLS:
            assert hermes_name in mock_ctx.registered_tool_names, (
                f"Missing workflow tool: {hermes_name}"
            )
        assert "oa_state" in mock_ctx.registered_tool_names

        # Check guard wrappers
        for tool_name in GUARDED_TOOLS:
            assert tool_name in mock_ctx.registered_tool_names, (
                f"Missing guard wrapper: {tool_name}"
            )

    def test_register_lifecycle_hooks_preserve_runtime_session_id(self, mock_ctx):
        """Registered session hooks should forward Hermes runtime kwargs."""
        register(mock_ctx)

        start_hooks = mock_ctx.get_registered_hooks("on_session_start")
        assert len(start_hooks) == 1

        start_hooks[0](session_id="runtime-session")
        state_tool = mock_ctx.get_registered_tool("oa_state")
        assert state_tool is not None


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


class TestSessionLifecycle:
    """on_session_start/end manage bridge lifecycle."""

    def test_session_start_initializes_bridge(self, mock_ctx, mock_bridge):
        """on_session_start should call bridge.start and lifecycle.sessionCreated."""
        mock_bridge.set_response("lifecycle.sessionCreated", None)
        _on_session_start(mock_ctx, mock_bridge, session_id=mock_ctx.session_id)
        assert mock_bridge.is_alive
        session_calls = mock_bridge.get_calls("lifecycle.sessionCreated")
        assert len(session_calls) == 1
        assert session_calls[0][1]["sessionId"] == mock_ctx.session_id

    def test_session_end_shuts_down_bridge(self, mock_ctx, mock_bridge):
        """on_session_end should call lifecycle.sessionDeleted and shutdown."""
        mock_bridge.start(mock_ctx.project_dir)
        mock_bridge.set_response("lifecycle.sessionDeleted", None)
        _on_session_end(mock_ctx, mock_bridge, session_id=mock_ctx.session_id)
        assert not mock_bridge.is_alive


# ---------------------------------------------------------------------------
# Mode selection → state → guard enforcement
# ---------------------------------------------------------------------------


class TestPhaseProgression:
    """Full flow from MODE_SELECT through guard enforcement."""

    @pytest.mark.asyncio
    async def test_select_mode_then_guard_blocks_writes(self, started_bridge):
        """After selecting GREENFIELD mode (PLANNING/DRAFT), writes should be blocked."""
        # select_mode response
        started_bridge.set_response(
            "tool.execute", "Mode set to GREENFIELD. Transitioning to PLANNING/DRAFT."
        )

        from hermes_adapter.workflow_tools import _handle_workflow_tool

        result = _handle_workflow_tool(
            started_bridge,
            "select_mode",
            "s1",
            "/tmp/p",
            {"mode": "GREENFIELD", "feature_name": "test-feat"},
        )
        assert "GREENFIELD" in result

        # Now guard should block write_file in PLANNING/DRAFT
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": False,
                "reason": "writes blocked in PLANNING/DRAFT",
                "phase": "PLANNING",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock(return_value="should not run")
        guard_result = await _guarded_handler(
            started_bridge,
            original,
            "write_file",
            "s1",
            {"path": "src/main.py", "content": "hello"},
        )
        parsed = json.loads(guard_result)
        assert "error" in parsed
        original.assert_not_called()

    @pytest.mark.asyncio
    async def test_guard_allows_writes_in_implementation(self, started_bridge):
        """In IMPLEMENTATION/DRAFT, writes to allowed files should pass through."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": True,
                "reason": "",
                "phase": "IMPLEMENTATION",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock(return_value="file written successfully")
        result = await _guarded_handler(
            started_bridge,
            original,
            "write_file",
            "s1",
            {"path": "src/auth.py", "content": "def login(): ..."},
        )
        assert result == "file written successfully"
        original.assert_called_once()

    @pytest.mark.asyncio
    async def test_state_check_returns_current_phase(self, started_bridge):
        """oa_state should return current workflow state."""
        started_bridge.set_response(
            "state.get",
            {
                "phase": "INTERFACES",
                "phaseState": "DRAFT",
                "mode": "GREENFIELD",
                "featureName": "test-feat",
                "currentTaskId": None,
            },
        )
        from hermes_adapter.workflow_tools import _handle_oa_state

        result = _handle_oa_state(started_bridge, "s1")
        parsed = json.loads(result)
        assert parsed["phase"] == "INTERFACES"
        assert parsed["mode"] == "GREENFIELD"


# ---------------------------------------------------------------------------
# Resume after crash
# ---------------------------------------------------------------------------


class TestResumeAfterCrash:
    """Bridge death mid-session → reconnect → state preserved."""

    @pytest.mark.asyncio
    async def test_bridge_recovers_after_death(self, started_bridge):
        """After bridge dies, next call should attempt reconnect."""
        # First call works
        started_bridge.set_response(
            "state.get", {"phase": "PLANNING", "phaseState": "DRAFT"}
        )
        from hermes_adapter.workflow_tools import _handle_oa_state

        result1 = _handle_oa_state(started_bridge, "s1")
        assert "PLANNING" in result1

        # Bridge "dies" — set response to raise error, then recover
        call_count = 0

        def flaky(params):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise BridgeError("subprocess died")
            return {"phase": "PLANNING", "phaseState": "DRAFT"}

        started_bridge.set_response_fn("state.get", flaky)

        # First attempt after death — error
        result2 = _handle_oa_state(started_bridge, "s1")
        parsed = json.loads(result2)
        assert "error" in parsed

        # Second attempt — recovered
        result3 = _handle_oa_state(started_bridge, "s1")
        parsed3 = json.loads(result3)
        assert parsed3["phase"] == "PLANNING"


# ---------------------------------------------------------------------------
# Prompt injection during workflow
# ---------------------------------------------------------------------------


class TestPromptDuringWorkflow:
    """Prompt hook returns phase-appropriate context during workflow."""

    def test_prompt_reflects_current_phase(self, started_bridge):
        """Prompt should change as workflow advances."""
        started_bridge.set_response(
            "prompt.build", "## PLANNING/DRAFT\nDraft your plan."
        )
        hook = create_prompt_hook(started_bridge, "s1")
        r1 = hook()
        assert "PLANNING" in r1["context"]

        # "Advance" — bridge now returns INTERFACES prompt
        started_bridge.set_response(
            "prompt.build", "## INTERFACES/DRAFT\nDefine interfaces."
        )
        r2 = hook()
        assert "INTERFACES" in r2["context"]
