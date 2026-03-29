"""
test_workflow_tools.py — Tests for workflow tool registration and delegation.

Verifies that all 13 workflow tools + oa_state are registered correctly,
delegate to the bridge with correct args, and pass through errors.
"""
from __future__ import annotations

import json
import pytest

from hermes_adapter.workflow_tools import (
    register_workflow_tools,
    _handle_workflow_tool,
    _handle_oa_state,
)
from hermes_adapter.constants import WORKFLOW_TOOLS, TOOLSET_NAME
from hermes_adapter.types import BridgeError

from conftest import MockBridgeClient, MockHermesContext


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


class TestToolRegistration:
    """register_workflow_tools registers all tools with correct schemas."""

    def test_registers_all_13_workflow_tools(self, mock_ctx, mock_bridge):
        """Should register all 13 workflow tools from WORKFLOW_TOOLS."""
        register_workflow_tools(mock_ctx, mock_bridge)
        for hermes_name, bridge_name, desc, schema in WORKFLOW_TOOLS:
            tool = mock_ctx.get_registered_tool(hermes_name)
            assert tool is not None, f"Tool {hermes_name} not registered"
            assert tool["toolset"] == TOOLSET_NAME
            assert tool["description"] == desc

    def test_registers_oa_state(self, mock_ctx, mock_bridge):
        """Should register the oa_state tool."""
        register_workflow_tools(mock_ctx, mock_bridge)
        tool = mock_ctx.get_registered_tool("oa_state")
        assert tool is not None
        assert tool["toolset"] == TOOLSET_NAME

    def test_total_tool_count_is_14(self, mock_ctx, mock_bridge):
        """13 workflow tools + oa_state = 14 total."""
        register_workflow_tools(mock_ctx, mock_bridge)
        assert len(mock_ctx.registered_tool_names) == 14

    def test_all_handlers_are_callable(self, mock_ctx, mock_bridge):
        """Every registered tool's handler should be callable."""
        register_workflow_tools(mock_ctx, mock_bridge)
        for name in mock_ctx.registered_tool_names:
            tool = mock_ctx.get_registered_tool(name)
            assert callable(tool["handler"]), f"Handler for {name} is not callable"

    def test_tool_schemas_have_required_fields(self, mock_ctx, mock_bridge):
        """Each tool schema should have 'type' and 'properties'."""
        register_workflow_tools(mock_ctx, mock_bridge)
        for name in mock_ctx.registered_tool_names:
            tool = mock_ctx.get_registered_tool(name)
            schema = tool["parameters"]
            assert "type" in schema, f"Schema for {name} missing 'type'"
            assert "properties" in schema, f"Schema for {name} missing 'properties'"


# ---------------------------------------------------------------------------
# Bridge delegation
# ---------------------------------------------------------------------------


class TestBridgeDelegation:
    """Workflow tool handlers delegate to bridge tool.execute."""

    @pytest.mark.asyncio
    async def test_delegates_to_tool_execute(self, started_bridge):
        """_handle_workflow_tool should call tool.execute with correct args."""
        started_bridge.set_response("tool.execute", "Mode set to GREENFIELD.")
        result = await _handle_workflow_tool(
            started_bridge,
            "select_mode",
            "test-session",
            "/tmp/project",
            {"mode": "GREENFIELD", "feature_name": "my-feat"},
        )
        assert "GREENFIELD" in result
        calls = started_bridge.get_calls("tool.execute")
        assert len(calls) == 1
        params = calls[0][1]
        assert params["name"] == "select_mode"
        assert params["args"]["mode"] == "GREENFIELD"
        assert params["context"]["sessionId"] == "test-session"
        assert params["context"]["directory"] == "/tmp/project"

    @pytest.mark.asyncio
    async def test_returns_bridge_response_as_string(self, started_bridge):
        """Handler should return the bridge result as a string."""
        started_bridge.set_response("tool.execute", "Artifact submitted for review.")
        result = await _handle_workflow_tool(
            started_bridge,
            "request_review",
            "s1",
            "/tmp/p",
            {"summary": "Done", "artifact_description": "Plan"},
        )
        assert result == "Artifact submitted for review."

    @pytest.mark.asyncio
    async def test_returns_structured_result_as_json(self, started_bridge):
        """If bridge returns a dict, handler should JSON-serialize it."""
        started_bridge.set_response("tool.execute", {"phase": "PLANNING", "approved": True})
        result = await _handle_workflow_tool(
            started_bridge, "check_prior_workflow", "s1", "/tmp/p",
            {"feature_name": "feat"},
        )
        parsed = json.loads(result)
        assert parsed["phase"] == "PLANNING"


# ---------------------------------------------------------------------------
# oa_state
# ---------------------------------------------------------------------------


class TestOaState:
    """oa_state calls state.get directly, not tool.execute."""

    @pytest.mark.asyncio
    async def test_calls_state_get(self, started_bridge):
        """oa_state should call state.get, not tool.execute."""
        started_bridge.set_response("state.get", {
            "phase": "PLANNING",
            "phaseState": "DRAFT",
            "mode": "GREENFIELD",
            "featureName": "my-feat",
        })
        result = await _handle_oa_state(started_bridge, "test-session")
        # Should have called state.get
        state_calls = started_bridge.get_calls("state.get")
        assert len(state_calls) == 1
        assert state_calls[0][1]["sessionId"] == "test-session"
        # Should NOT have called tool.execute
        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 0

    @pytest.mark.asyncio
    async def test_returns_state_as_json(self, started_bridge):
        """oa_state should return the state as a JSON string."""
        state = {"phase": "INTERFACES", "phaseState": "REVIEW", "mode": "GREENFIELD"}
        started_bridge.set_response("state.get", state)
        result = await _handle_oa_state(started_bridge, "s1")
        parsed = json.loads(result)
        assert parsed["phase"] == "INTERFACES"


# ---------------------------------------------------------------------------
# Error passthrough
# ---------------------------------------------------------------------------


class TestErrorPassthrough:
    """Bridge errors are returned as structured JSON, not raised."""

    @pytest.mark.asyncio
    async def test_bridge_error_returns_error_json(self, started_bridge):
        """BridgeError should be caught and returned as error JSON."""
        started_bridge.set_response("tool.execute", None)

        def raise_error(params):
            raise BridgeError("Connection lost")

        started_bridge.set_response_fn("tool.execute", raise_error)

        result = await _handle_workflow_tool(
            started_bridge, "select_mode", "s1", "/tmp/p",
            {"mode": "GREENFIELD", "feature_name": "feat"},
        )
        parsed = json.loads(result)
        assert "error" in parsed

    @pytest.mark.asyncio
    async def test_bridge_validation_error_passthrough(self, started_bridge):
        """Bridge validation errors (Error: ...) are passed through as-is."""
        started_bridge.set_response(
            "tool.execute",
            "Error: select_mode can only be called during MODE_SELECT.",
        )
        result = await _handle_workflow_tool(
            started_bridge, "select_mode", "s1", "/tmp/p",
            {"mode": "GREENFIELD", "feature_name": "feat"},
        )
        assert "Error:" in result

    @pytest.mark.asyncio
    async def test_missing_required_arg_returns_clean_error(self, started_bridge):
        """Missing required args (e.g. no mode) should relay bridge error cleanly."""
        started_bridge.set_response(
            "tool.execute",
            "Error: feature_name is required.",
        )
        result = await _handle_workflow_tool(
            started_bridge, "select_mode", "s1", "/tmp/p",
            {"mode": "GREENFIELD"},  # missing feature_name
        )
        assert "Error:" in result
        assert "feature_name" in result

    @pytest.mark.asyncio
    async def test_missing_mode_returns_clean_error(self, started_bridge):
        """Missing mode arg should relay bridge error cleanly."""
        started_bridge.set_response(
            "tool.execute",
            "Error: mode is required and must be one of: GREENFIELD, REFACTOR, INCREMENTAL.",
        )
        result = await _handle_workflow_tool(
            started_bridge, "select_mode", "s1", "/tmp/p",
            {"feature_name": "feat"},  # missing mode
        )
        assert "Error:" in result
        assert "mode" in result.lower()

    @pytest.mark.asyncio
    async def test_wrong_phase_error_includes_current_state(self, started_bridge):
        """Phase mismatch errors should include the current phase for LLM context."""
        started_bridge.set_response(
            "tool.execute",
            "Error: mark_scan_complete can only be called at DISCOVERY/SCAN (current: PLANNING/DRAFT).",
        )
        result = await _handle_workflow_tool(
            started_bridge, "mark_scan_complete", "s1", "/tmp/p",
            {"scan_summary": "found stuff"},
        )
        assert "PLANNING/DRAFT" in result
