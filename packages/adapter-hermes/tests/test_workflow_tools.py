"""
test_workflow_tools.py — Tests for workflow tool registration and delegation.

Verifies that all workflow tools + oa_state are registered correctly,
delegate to the bridge with correct args, and pass through errors.
"""

from __future__ import annotations

import json
import pytest
from pathlib import Path
from unittest.mock import patch

from hermes_adapter.workflow_tools import (
    register_workflow_tools,
    _handle_workflow_tool,
    _handle_oa_state,
    _handle_recover_bridge,
    _handle_select_project,
)
from hermes_adapter.constants import WORKFLOW_TOOLS, TOOLSET_NAME
from hermes_adapter.types import BridgeError

from .conftest import MockBridgeClient, MockHermesContext


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------


class TestToolRegistration:
    """register_workflow_tools registers all tools with correct schemas."""

    def test_registers_all_workflow_tools(self, mock_ctx, mock_bridge):
        """Should register all workflow tools from WORKFLOW_TOOLS."""
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

    def test_registers_project_selection_tools(self, mock_ctx, mock_bridge):
        register_workflow_tools(mock_ctx, mock_bridge)
        assert mock_ctx.get_registered_tool("oa_list_projects") is not None
        assert mock_ctx.get_registered_tool("oa_select_project") is not None
        assert mock_ctx.get_registered_tool("oa_recover_bridge") is not None

    def test_manifest_declares_project_selection_tools(self):
        manifest = Path(__file__).parents[1] / "plugin.yaml"
        content = manifest.read_text()
        assert "- oa_list_projects" in content
        assert "- oa_select_project" in content
        assert "- oa_recover_bridge" in content

    def test_total_tool_count_matches_workflow_tools_plus_state(
        self, mock_ctx, mock_bridge
    ):
        """Total count should equal workflow tools plus oa_state."""
        register_workflow_tools(mock_ctx, mock_bridge)
        assert len(mock_ctx.registered_tool_names) == len(WORKFLOW_TOOLS) + 4

    def test_registers_oa_reset_task(self, mock_ctx, mock_bridge):
        """Should register the oa_reset_task workflow tool."""
        register_workflow_tools(mock_ctx, mock_bridge)
        tool = mock_ctx.get_registered_tool("oa_reset_task")
        assert tool is not None
        assert tool["toolset"] == TOOLSET_NAME

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

    def test_registered_handlers_fall_back_to_context_session_id(
        self, mock_ctx, mock_bridge
    ):
        """Hermes tool calls without session_id should reuse ctx.session_id, not 'default'."""
        mock_bridge.set_response("tool.execute", "Mode set to GREENFIELD.")
        register_workflow_tools(mock_ctx, mock_bridge)

        tool = mock_ctx.get_registered_tool("oa_select_mode")
        assert tool is not None

        result = tool["handler"](
            {"mode": "GREENFIELD", "feature_name": "ctx-session-feat"},
            cwd="/tmp/project",
        )

        assert "GREENFIELD" in result
        calls = mock_bridge.get_calls("tool.execute")
        assert len(calls) == 1
        assert calls[0][1]["context"]["sessionId"] == mock_ctx.session_id


# ---------------------------------------------------------------------------
# Bridge delegation
# ---------------------------------------------------------------------------


class TestBridgeDelegation:
    """Workflow tool handlers delegate to bridge tool.execute."""

    def test_delegates_to_tool_execute(self, started_bridge):
        """_handle_workflow_tool should call tool.execute with correct args."""
        started_bridge.set_response("tool.execute", "Mode set to GREENFIELD.")
        result = _handle_workflow_tool(
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

    def test_delegates_to_default_when_runtime_session_is_empty(self, started_bridge):
        """Resumed Hermes sessions should use the active persisted default workflow."""
        def state_response(params):
            if params["sessionId"] == "runtime-session":
                return {"phase": "MODE_SELECT", "phaseState": "DRAFT"}
            if params["sessionId"] == "default":
                return {"phase": "INTERFACES", "phaseState": "REVISE"}
            return None

        started_bridge.set_response_fn("state.get", state_response)
        started_bridge.set_response("tool.execute", "Review requested.")

        result = _handle_workflow_tool(
            started_bridge,
            "request_review",
            "runtime-session",
            "/tmp/project",
            {"artifact_files": ["/tmp/project/packages/core/types.ts"]},
        )

        assert "Review requested" in result
        calls = started_bridge.get_calls("tool.execute")
        assert calls[0][1]["context"]["sessionId"] == "default"

    def test_reset_task_delegates_task_ids(self, started_bridge):
        """oa_reset_task should relay task_ids to bridge tool.execute."""
        started_bridge.set_response("tool.execute", "Reset tasks: T3")
        result = _handle_workflow_tool(
            started_bridge,
            "reset_task",
            "test-session",
            "/tmp/project",
            {"task_ids": ["T3"]},
        )
        assert "T3" in result
        calls = started_bridge.get_calls("tool.execute")
        assert len(calls) == 1
        params = calls[0][1]
        assert params["name"] == "reset_task"
        assert params["args"]["task_ids"] == ["T3"]

    def test_submit_task_review_delegates_review_output(self, started_bridge):
        """oa_submit_task_review should relay review_output to bridge tool.execute."""
        started_bridge.set_response("tool.execute", 'Task "T1" review passed.')
        result = _handle_workflow_tool(
            started_bridge,
            "submit_task_review",
            "test-session",
            "/tmp/project",
            {"review_output": '{"passed": true, "issues": []}'},
        )
        assert "review passed" in result
        calls = started_bridge.get_calls("tool.execute")
        assert len(calls) == 1
        params = calls[0][1]
        assert params["name"] == "submit_task_review"
        assert params["args"]["review_output"] == '{"passed": true, "issues": []}'

    def test_mark_satisfied_blocked_during_review(self, started_bridge):
        """Hermes final phase review must be submitted by the isolated reviewer."""
        started_bridge.set_response("state.get", {"phase": "PLANNING", "phaseState": "REVIEW"})
        result = _handle_workflow_tool(
            started_bridge,
            "mark_satisfied",
            "test-session",
            "/tmp/project",
            {"criteria_met": []},
        )

        parsed = json.loads(result)
        assert "isolated phase reviewer" in parsed["error"]
        assert started_bridge.get_calls("tool.execute") == []

    def test_submit_feedback_relays_user_message_first(self, started_bridge):
        """submit_feedback should relay the actual user text through message.process first."""
        started_bridge.set_response(
            "message.process", {"intercepted": True, "parts": []}
        )
        started_bridge.set_response(
            "tool.execute", "Approved. Transitioning to PLANNING/DRAFT."
        )

        result = _handle_workflow_tool(
            started_bridge,
            "submit_feedback",
            "test-session",
            "/tmp/project",
            {"feedback_type": "approve", "feedback_text": "approved"},
        )

        assert "Approved" in result
        message_calls = started_bridge.get_calls("message.process")
        assert len(message_calls) == 1
        assert message_calls[0][1]["sessionId"] == "test-session"
        assert message_calls[0][1]["parts"][0]["text"] == "approved"

    def test_submit_feedback_without_feedback_text_still_marks_user_message(
        self, started_bridge
    ):
        """submit_feedback should still call message.process when Hermes omits feedback_text."""
        started_bridge.set_response(
            "message.process", {"intercepted": True, "parts": []}
        )
        started_bridge.set_response(
            "tool.execute", "Approval recorded. Transitioning to PLANNING/DRAFT."
        )

        result = _handle_workflow_tool(
            started_bridge,
            "submit_feedback",
            "test-session",
            "/tmp/project",
            {"feedback_type": "approve"},
        )

        assert "Approval recorded" in result
        message_calls = started_bridge.get_calls("message.process")
        assert len(message_calls) == 1
        assert (
            message_calls[0][1]["parts"][0]["text"]
            == "(user invoked submit_feedback via Hermes)"
        )

    def test_post_tool_reprompt_launches_autonomous_continuation(self, started_bridge):
        """A workflow tool leaving the session in DRAFT/REVISE must not rely on session-end detection."""
        started_bridge.set_response(
            "message.process", {"intercepted": True, "parts": []}
        )
        started_bridge.set_response("tool.execute", "Approved. Transitioning to PLANNING/DRAFT.")
        started_bridge.set_response(
            "idle.check",
            {
                "action": "reprompt",
                "message": "Continue drafting the PLANNING artifact.",
                "retryCount": 1,
            },
        )

        with (
            patch(
                "hermes_adapter.workflow_tools.continuation.build_continuation_request",
                return_value={
                    "sessionId": "s1",
                    "surface": {"kind": "gateway_messaging", "platform": "discord"},
                    "gatewayRouting": {
                        "platform": "discord",
                        "chatId": "1498151051981885531",
                        "threadId": "thread-1",
                        "userId": "941009272429506612",
                        "messageId": "msg-1",
                        "sessionOrigin": "discord:1498151051981885531:thread-1",
                    },
                    "message": "Continue drafting the PLANNING artifact.",
                },
            ) as build_request,
            patch(
                "hermes_adapter.workflow_tools.continuation.execute_continuation",
                return_value={
                    "kind": "handoff_requested",
                    "strategy": "gateway_handoff",
                    "sessionId": "s1",
                    "detail": "queued for gateway delivery",
                },
            ) as execute_continuation,
        ):
            result = _handle_workflow_tool(
                started_bridge,
                "submit_feedback",
                "s1",
                "/tmp/project",
                {"feedback_type": "approve", "feedback_text": "approved"},
                platform="discord",
                source="gateway",
                chat_id="1498151051981885531",
                thread_id="thread-1",
                user_id="941009272429506612",
                message_id="msg-1",
                session_origin="discord:1498151051981885531:thread-1",
            )

        assert result == "Approved. Transitioning to PLANNING/DRAFT."
        build_request.assert_called_once()
        assert build_request.call_args.kwargs["idle_decision"]["message"] == "Continue drafting the PLANNING artifact."
        execute_continuation.assert_called_once()
        assert started_bridge.get_calls("idle.check") == [("idle.check", {"sessionId": "s1"})]

    def test_post_tool_reprompt_treats_redraft_as_active_non_gate_work(self, started_bridge):
        """Structural REDRAFT should trigger the same autonomous continuation path as DRAFT/REVISE."""
        started_bridge.set_response("tool.execute", "Revision requested. Transitioning to PLANNING/REDRAFT.")
        started_bridge.set_response(
            "idle.check",
            {"action": "reprompt", "message": "Continue the redraft now.", "retryCount": 1},
        )

        with (
            patch(
                "hermes_adapter.workflow_tools.continuation.build_continuation_request",
                return_value={"sessionId": "s1", "surface": {"kind": "direct_cli"}, "message": "Continue the redraft now."},
            ) as build_request,
            patch(
                "hermes_adapter.workflow_tools.continuation.execute_continuation",
                return_value={"kind": "continued", "strategy": "native_session", "sessionId": "s1", "detail": "continued locally"},
            ) as execute_continuation,
        ):
            result = _handle_workflow_tool(
                started_bridge,
                "propose_backtrack",
                "s1",
                "/tmp/project",
                {"target_phase": "PLANNING", "reason": "Need explicit redraft semantics before implementation."},
            )

        assert result == "Revision requested. Transitioning to PLANNING/REDRAFT."
        build_request.assert_called_once()
        execute_continuation.assert_called_once()

    def test_post_tool_reprompt_recovers_discord_routing_from_session_key(self, started_bridge, monkeypatch):
        """Gateway tool calls run in a worker thread where only HERMES_SESSION_KEY may survive."""
        monkeypatch.setenv(
            "HERMES_SESSION_KEY",
            "agent:main:discord:thread:1498867561683751044:1498867561683751044",
        )
        started_bridge.set_response(
            "message.process", {"intercepted": True, "parts": []}
        )
        started_bridge.set_response("tool.execute", "Routed your feedback.")
        started_bridge.set_response(
            "idle.check",
            {
                "action": "reprompt",
                "message": "Continue revising the Open Artisan artifact.",
                "retryCount": 1,
            },
        )

        with patch(
            "hermes_adapter.workflow_tools.continuation.execute_continuation",
            return_value={
                "kind": "handoff_requested",
                "strategy": "gateway_handoff",
                "sessionId": "s1",
                "detail": "queued for gateway delivery",
            },
        ) as execute_continuation:
            result = _handle_workflow_tool(
                started_bridge,
                "submit_feedback",
                "s1",
                "/tmp/project",
                {"feedback_type": "revise", "feedback_text": "revise"},
            )

        assert result == "Routed your feedback."
        execute_continuation.assert_called_once()
        request = execute_continuation.call_args.args[0]
        assert request["gatewayRouting"] == {
            "platform": "discord",
            "chatId": "1498867561683751044",
            "threadId": "1498867561683751044",
            "sessionOrigin": "agent:main:discord:thread:1498867561683751044:1498867561683751044",
        }

    def test_returns_bridge_response_as_string(self, started_bridge):
        """Handler should return the bridge result as a string."""
        started_bridge.set_response("tool.execute", "Artifact submitted for review.")
        result = _handle_workflow_tool(
            started_bridge,
            "request_review",
            "s1",
            "/tmp/p",
            {"summary": "Done", "artifact_description": "Plan"},
        )
        assert result == "Artifact submitted for review."

    def test_recover_bridge_delegates_without_ensuring_session(self, started_bridge):
        started_bridge.set_response(
            "recover_stale_bridge",
            {
                "kind": "stale_bridge_recovered",
                "clearedPaths": ["/tmp/project/.openartisan/.bridge-pid"],
                "pluginReloaded": False,
            },
        )

        result = _handle_recover_bridge(started_bridge, "test-session", "/tmp/project")

        parsed = json.loads(result)
        assert parsed["kind"] == "stale_bridge_recovered"
        assert parsed["pluginReloaded"] is False
        assert started_bridge.get_calls("recover_stale_bridge")[0][1]["projectDir"].endswith("/tmp/project")
        assert started_bridge.get_calls("lifecycle.sessionCreated") == []

    def test_request_review_dispatches_phase_review_immediately(self, started_bridge):
        """Hermes may keep polling tools without another pre_llm_call after request_review."""
        started_bridge.set_response("tool.execute", "Artifact submitted for review.")
        started_bridge.set_response(
            "state.get", {"phase": "IMPLEMENTATION", "phaseState": "REVIEW"}
        )

        with patch("hermes_adapter.prompt_hook.dispatch_phase_review") as dispatch:
            result = _handle_workflow_tool(
                started_bridge,
                "request_review",
                "s1",
                "/tmp/p",
                {"summary": "Done", "artifact_description": "Implementation"},
            )

        assert result == "Artifact submitted for review."
        dispatch.assert_called_once_with(
            started_bridge,
            "s1",
            {"phase": "IMPLEMENTATION", "phaseState": "REVIEW"},
            "/tmp/p",
        )

    def test_returns_structured_result_as_json(self, started_bridge):
        """If bridge returns a dict, handler should JSON-serialize it."""
        started_bridge.set_response(
            "tool.execute", {"phase": "PLANNING", "approved": True}
        )
        result = _handle_workflow_tool(
            started_bridge,
            "check_prior_workflow",
            "s1",
            "/tmp/p",
            {"feature_name": "feat"},
        )
        parsed = json.loads(result)
        assert parsed["phase"] == "PLANNING"

    def test_select_project_binds_session_to_project(self, started_bridge, tmp_path: Path):
        project_dir = tmp_path / "repo"
        feature_dir = project_dir / ".openartisan" / "feature-a"
        feature_dir.mkdir(parents=True)
        (feature_dir / "workflow-state.json").write_text("{}")

        result = _handle_select_project(
            started_bridge,
            "test-session",
            {"project_dir": str(project_dir)},
        )

        parsed = json.loads(result)
        assert parsed["selectedProjectDir"] == str(project_dir.resolve())
        assert parsed["sessionId"] == "test-session"
        lifecycle_calls = started_bridge.get_calls("lifecycle.sessionCreated")
        assert lifecycle_calls[-1][1]["sessionId"] == "test-session"

    def test_state_uses_selected_project_dir(self, started_bridge, tmp_path: Path):
        project_dir = tmp_path / "repo"
        feature_dir = project_dir / ".openartisan" / "feature-a"
        feature_dir.mkdir(parents=True)
        (feature_dir / "workflow-state.json").write_text("{}")

        _handle_select_project(
            started_bridge,
            "test-session",
            {"project_dir": str(project_dir)},
        )
        started_bridge.set_response("state.get", {"state": {"phase": "PLANNING"}})

        _handle_oa_state(started_bridge, "test-session", "/wrong/fallback")

        assert started_bridge._project_dir == str(project_dir.resolve())


# ---------------------------------------------------------------------------
# oa_state
# ---------------------------------------------------------------------------


class TestOaState:
    """oa_state calls state.get directly, not tool.execute."""

    def test_calls_state_get(self, started_bridge):
        """oa_state should call state.get, not tool.execute."""
        started_bridge.set_response(
            "state.get",
            {
                "phase": "PLANNING",
                "phaseState": "DRAFT",
                "mode": "GREENFIELD",
                "featureName": "my-feat",
            },
        )
        result = _handle_oa_state(started_bridge, "test-session")
        # Should have called state.get
        state_calls = started_bridge.get_calls("state.get")
        assert len(state_calls) == 1
        assert state_calls[0][1]["sessionId"] == "test-session"
        assert state_calls[0][1]["includeRuntimeHealth"] is True
        # Should NOT have called tool.execute
        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 0

    def test_returns_state_as_json(self, started_bridge):
        """oa_state should return the state as a JSON string."""
        state = {"phase": "INTERFACES", "phaseState": "REVIEW", "mode": "GREENFIELD"}
        started_bridge.set_response(
            "state.get",
            {
                "state": state,
                "runtimeHealth": {
                    "bridgeTransport": "unix-socket",
                    "lastRecoveryAction": "attached-shared-bridge",
                    "noopReason": None,
                },
            },
        )
        result = _handle_oa_state(started_bridge, "s1")
        parsed = json.loads(result)
        assert parsed["phase"] == "INTERFACES"
        assert parsed["runtimeHealth"]["bridgeTransport"] == "unix-socket"

    def test_uses_default_state_when_runtime_session_is_empty(self, started_bridge):
        """oa_state should report the active default workflow for resumed Hermes sessions."""
        def state_response(params):
            if params["sessionId"] == "runtime-session":
                return {
                    "state": {"phase": "MODE_SELECT", "phaseState": "DRAFT"},
                    "runtimeHealth": {"noopReason": None},
                }
            if params["sessionId"] == "default":
                return {
                    "state": {"phase": "INTERFACES", "phaseState": "REVISE"},
                    "runtimeHealth": {"noopReason": None},
                }
            return None

        started_bridge.set_response_fn("state.get", state_response)

        result = _handle_oa_state(started_bridge, "runtime-session")

        parsed = json.loads(result)
        assert parsed["phase"] == "INTERFACES"
        state_calls = started_bridge.get_calls("state.get")
        assert state_calls[0][1]["sessionId"] == "runtime-session"
        assert state_calls[1][1]["sessionId"] == "default"

    def test_uses_default_state_when_runtime_session_missing(self, started_bridge):
        """oa_state should fall back when the runtime session has no bridge state."""
        def state_response(params):
            if params["sessionId"] == "runtime-session":
                return None
            if params["sessionId"] == "default":
                return {
                    "state": {"phase": "INTERFACES", "phaseState": "REVISE"},
                    "runtimeHealth": {"noopReason": None},
                }
            return None

        started_bridge.set_response_fn("state.get", state_response)

        result = _handle_oa_state(started_bridge, "runtime-session")

        parsed = json.loads(result)
        assert parsed["phase"] == "INTERFACES"
        state_calls = started_bridge.get_calls("state.get")
        assert state_calls[0][1]["sessionId"] == "runtime-session"
        assert state_calls[1][1]["sessionId"] == "default"


# ---------------------------------------------------------------------------
# Error passthrough
# ---------------------------------------------------------------------------


class TestErrorPassthrough:
    """Bridge errors are returned as structured JSON, not raised."""

    def test_bridge_error_returns_error_json(self, started_bridge):
        """BridgeError should be caught and returned as error JSON."""
        started_bridge.set_response("tool.execute", None)

        def raise_error(params):
            raise BridgeError("Connection lost")

        started_bridge.set_response_fn("tool.execute", raise_error)

        result = _handle_workflow_tool(
            started_bridge,
            "select_mode",
            "s1",
            "/tmp/p",
            {"mode": "GREENFIELD", "feature_name": "feat"},
        )
        parsed = json.loads(result)
        assert "error" in parsed

    def test_bridge_validation_error_passthrough(self, started_bridge):
        """Bridge validation errors (Error: ...) are passed through as-is."""
        started_bridge.set_response(
            "tool.execute",
            "Error: select_mode can only be called during MODE_SELECT.",
        )
        result = _handle_workflow_tool(
            started_bridge,
            "select_mode",
            "s1",
            "/tmp/p",
            {"mode": "GREENFIELD", "feature_name": "feat"},
        )
        assert "Error:" in result

    def test_missing_required_arg_returns_clean_error(self, started_bridge):
        """Missing required args (e.g. no mode) should relay bridge error cleanly."""
        started_bridge.set_response(
            "tool.execute",
            "Error: feature_name is required.",
        )
        result = _handle_workflow_tool(
            started_bridge,
            "select_mode",
            "s1",
            "/tmp/p",
            {"mode": "GREENFIELD"},  # missing feature_name
        )
        assert "Error:" in result
        assert "feature_name" in result

    def test_missing_mode_returns_clean_error(self, started_bridge):
        """Missing mode arg should relay bridge error cleanly."""
        started_bridge.set_response(
            "tool.execute",
            "Error: mode is required and must be one of: GREENFIELD, REFACTOR, INCREMENTAL.",
        )
        result = _handle_workflow_tool(
            started_bridge,
            "select_mode",
            "s1",
            "/tmp/p",
            {"feature_name": "feat"},  # missing mode
        )
        assert "Error:" in result
        assert "mode" in result.lower()

    def test_wrong_phase_error_includes_current_state(self, started_bridge):
        """Phase mismatch errors should include the current phase for LLM context."""
        started_bridge.set_response(
            "tool.execute",
            "Error: mark_scan_complete can only be called at DISCOVERY/SCAN (current: PLANNING/DRAFT).",
        )
        result = _handle_workflow_tool(
            started_bridge,
            "mark_scan_complete",
            "s1",
            "/tmp/p",
            {"scan_summary": "found stuff"},
        )
        assert "PLANNING/DRAFT" in result
