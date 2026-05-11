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
from hermes_adapter.session_projects import clear_active_session_id, clear_session_project_dir, set_active_session_id, set_last_session_context, set_last_user_message
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

    def test_manifest_declares_all_registered_workflow_tools(self):
        manifest = Path(__file__).parents[1] / "plugin.yaml"
        content = manifest.read_text()
        for hermes_name, _, _, _ in WORKFLOW_TOOLS:
            assert f"- {hermes_name}" in content
        assert "- oa_state" in content

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
        assert tool["parameters"]["properties"]["reason"]["type"] == "string"

    def test_submit_feedback_schema_accepts_resolved_human_gates(self, mock_ctx, mock_bridge):
        register_workflow_tools(mock_ctx, mock_bridge)
        tool = mock_ctx.get_registered_tool("oa_submit_feedback")
        assert tool is not None
        properties = tool["parameters"]["properties"]
        assert properties["resolved_human_gates"]["type"] == "array"
        assert properties["resolved_human_gates"]["items"]["type"] == "string"

    def test_registers_boundary_change_tools(self, mock_ctx, mock_bridge):
        register_workflow_tools(mock_ctx, mock_bridge)

        analyze = mock_ctx.get_registered_tool("oa_analyze_task_boundary_change")
        assert analyze is not None
        assert analyze["toolset"] == TOOLSET_NAME
        assert analyze["parameters"]["required"] == ["task_id", "reason"]
        assert analyze["parameters"]["properties"]["add_files"]["items"]["type"] == "string"

        apply = mock_ctx.get_registered_tool("oa_apply_task_boundary_change")
        assert apply is not None
        assert apply["toolset"] == TOOLSET_NAME
        assert apply["parameters"]["required"] == [
            "task_id",
            "reason",
            "expected_impacted_tasks",
            "expected_reset_tasks",
        ]
        assert apply["parameters"]["properties"]["expected_reset_tasks"]["items"]["type"] == "string"

    def test_registers_patch_suggestion_application_tool(self, mock_ctx, mock_bridge):
        register_workflow_tools(mock_ctx, mock_bridge)

        tool = mock_ctx.get_registered_tool("oa_apply_patch_suggestion")
        assert tool is not None
        assert tool["toolset"] == TOOLSET_NAME
        assert tool["parameters"]["required"] == ["patch_suggestion_id"]
        assert tool["parameters"]["properties"]["force"]["type"] == "boolean"

    def test_registers_drift_repair_tools(self, mock_ctx, mock_bridge):
        register_workflow_tools(mock_ctx, mock_bridge)

        bridge_tool_names = {bridge_name for _, bridge_name, _, _ in WORKFLOW_TOOLS}
        assert "report_drift" in bridge_tool_names
        assert "plan_drift_repair" in bridge_tool_names
        assert "apply_drift_repair" in bridge_tool_names
        report = mock_ctx.get_registered_tool("oa_report_drift")
        plan = mock_ctx.get_registered_tool("oa_plan_drift_repair")
        apply = mock_ctx.get_registered_tool("oa_apply_drift_repair")
        assert report is not None
        assert plan is not None
        assert apply is not None
        assert report["parameters"]["properties"]["changed_files"]["items"]["type"] == "string"
        assert report["parameters"]["properties"]["drifted_artifact_keys"]["items"]["enum"] == ["design", "conventions", "plan", "interfaces", "tests", "impl_plan", "implementation"]
        assert "artifact_keys" not in report["parameters"]["properties"]
        assert plan["parameters"]["properties"]["strategy"]["enum"] == ["minimal", "safe-auto", "ask-first"]
        assert apply["parameters"]["required"] == ["repair_plan_id"]

    def test_manifest_declares_patch_suggestion_application_tool(self):
        manifest = Path(__file__).parents[1] / "plugin.yaml"
        content = manifest.read_text()
        assert "- oa_apply_patch_suggestion" in content

    def test_manifest_declares_drift_tools(self):
        manifest = Path(__file__).parents[1] / "plugin.yaml"
        content = manifest.read_text()
        assert "- oa_report_drift" in content
        assert "- oa_plan_drift_repair" in content
        assert "- oa_apply_drift_repair" in content

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

    def test_registered_handlers_use_active_session_when_context_is_default(
        self, mock_bridge
    ):
        """Gateway plugin contexts may be global/default while pre_tool_call has the real session."""
        ctx = MockHermesContext(session_id="default")
        mock_bridge.set_response("tool.execute", "Mode set to INCREMENTAL.")
        register_workflow_tools(ctx, mock_bridge)

        tool = ctx.get_registered_tool("oa_select_mode")
        assert tool is not None

        try:
            set_active_session_id("runtime-session")
            result = tool["handler"](
                {"mode": "INCREMENTAL", "feature_name": "ctx-session-feat"},
                cwd="/tmp/project",
            )
        finally:
            clear_active_session_id("runtime-session")

        assert "INCREMENTAL" in result
        calls = mock_bridge.get_calls("tool.execute")
        assert len(calls) == 1
        assert calls[0][1]["context"]["sessionId"] == "runtime-session"


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
            {"artifact_files": ["/tmp/project/packages/core/workflow-state-types.ts"]},
        )

        assert "Review requested" in result
        calls = started_bridge.get_calls("tool.execute")
        assert calls[0][1]["context"]["sessionId"] == "default"

    def test_select_mode_stays_on_runtime_session_when_default_is_active(self, started_bridge):
        """Fresh gateway sessions must be able to start a new feature even if default has an old workflow."""
        def state_response(params):
            if params["sessionId"] == "runtime-session":
                return {"phase": "MODE_SELECT", "phaseState": "DRAFT"}
            if params["sessionId"] == "default":
                return {"phase": "IMPLEMENTATION", "phaseState": "HUMAN_GATE"}
            return None

        started_bridge.set_response_fn("state.get", state_response)
        started_bridge.set_response("tool.execute", "Mode set to INCREMENTAL.")

        result = _handle_workflow_tool(
            started_bridge,
            "select_mode",
            "runtime-session",
            "/tmp/project",
            {"mode": "INCREMENTAL", "feature_name": "role-aware-tool-surface"},
        )

        assert "INCREMENTAL" in result
        calls = started_bridge.get_calls("tool.execute")
        assert calls[0][1]["context"]["sessionId"] == "runtime-session"

    def test_check_prior_workflow_stays_on_runtime_session_when_default_is_active(self, started_bridge):
        def state_response(params):
            if params["sessionId"] == "runtime-session":
                return {"phase": "MODE_SELECT", "phaseState": "DRAFT"}
            if params["sessionId"] == "default":
                return {"phase": "IMPLEMENTATION", "phaseState": "HUMAN_GATE"}
            return None

        started_bridge.set_response_fn("state.get", state_response)
        started_bridge.set_response("tool.execute", "No prior workflow found.")

        result = _handle_workflow_tool(
            started_bridge,
            "check_prior_workflow",
            "runtime-session",
            "/tmp/project",
            {"feature_name": "role-aware-tool-surface", "user_intent": "start role-aware tool surface"},
        )

        assert "No prior workflow" in result
        calls = started_bridge.get_calls("tool.execute")
        assert calls[0][1]["context"]["sessionId"] == "runtime-session"

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

    def test_submit_task_review_is_reviewer_reserved(self, started_bridge):
        """oa_submit_task_review is not author-callable; the hook submits reviewer output."""
        result = _handle_workflow_tool(
            started_bridge,
            "submit_task_review",
            "test-session",
            "/tmp/project",
            {"review_output": '{"passed": true, "issues": []}'},
        )
        parsed = json.loads(result)
        assert "reserved for isolated reviewers" in parsed["error"]
        assert started_bridge.get_calls("tool.execute") == []

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
        assert "reserved for isolated reviewers" in parsed["error"]
        assert started_bridge.get_calls("tool.execute") == []

    def test_submit_feedback_does_not_mark_user_message(self, started_bridge):
        """Model-callable submit_feedback must not satisfy USER_GATE itself."""
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
        assert started_bridge.get_calls("message.process") == []

    def test_submit_feedback_without_feedback_text_does_not_mark_user_message(
        self, started_bridge
    ):
        """Hermes tool calls are model-callable and cannot prove user input."""
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
        assert started_bridge.get_calls("message.process") == []

    def test_submit_feedback_passes_resolved_human_gates(self, started_bridge):
        started_bridge.set_response(
            "tool.execute", "Resolved 1 human gate(s): T1."
        )

        result = _handle_workflow_tool(
            started_bridge,
            "submit_feedback",
            "test-session",
            "/tmp/project",
            {
                "feedback_type": "approve",
                "feedback_text": "resolved",
                "resolved_human_gates": ["T1"],
            },
        )

        assert "Resolved 1 human gate" in result
        assert started_bridge.get_calls("message.process") == []
        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 1
        assert tool_calls[0][1]["args"]["resolved_human_gates"] == ["T1"]

    def test_post_tool_reprompt_launches_autonomous_continuation(self, started_bridge):
        """A workflow tool leaving the session in DRAFT/REVISE must not rely on session-end detection."""
        started_bridge.set_response(
            "message.process", {"intercepted": True, "parts": []}
        )
        started_bridge.set_response("tool.execute", "Approved. Transitioning to PLANNING/DRAFT.")
        started_bridge.set_response(
            "state.get",
            {
                "state": {"phase": "PLANNING", "phaseState": "DRAFT"},
                "runtimeHealth": {
                    "nextAction": "author_continue",
                    "shouldContinue": True,
                    "requiresAdapterAction": False,
                    "continuationMessage": "Continue drafting the PLANNING artifact.",
                },
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
        assert started_bridge.get_calls("idle.check") == []

    def test_post_tool_reprompt_treats_redraft_as_active_non_gate_work(self, started_bridge):
        """Structural REDRAFT should trigger the same autonomous continuation path as DRAFT/REVISE."""
        started_bridge.set_response("tool.execute", "Revision requested. Transitioning to PLANNING/REDRAFT.")
        started_bridge.set_response(
            "state.get",
            {
                "state": {"phase": "PLANNING", "phaseState": "REDRAFT"},
                "runtimeHealth": {
                    "nextAction": "author_continue",
                    "shouldContinue": True,
                    "requiresAdapterAction": False,
                    "continuationMessage": "Continue the redraft now.",
                },
            },
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
        assert started_bridge.get_calls("idle.check") == []

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
            "state.get",
            {
                "state": {"phase": "PLANNING", "phaseState": "REVISE"},
                "runtimeHealth": {
                    "nextAction": "author_continue",
                    "shouldContinue": True,
                    "requiresAdapterAction": False,
                    "continuationMessage": "Continue revising the Open Artisan artifact.",
                },
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
        assert started_bridge.get_calls("idle.check") == []

    def test_post_tool_reprompt_uses_cached_gateway_routing_when_tool_kwargs_are_sparse(self, started_bridge):
        """Gateway tool execution may omit routing kwargs even though pre_llm_call saw them."""
        set_last_session_context(
            "s1",
            {
                "platform": "discord",
                "source": "gateway",
                "chat_id": "1498151051981885531",
                "thread_id": "thread-1",
                "user_id": "941009272429506612",
                "message_id": "msg-1",
                "session_origin": "agent:main:discord:thread:1498151051981885531:thread-1",
            },
        )
        started_bridge.set_response("tool.execute", "Approved. Transitioning to INTERFACES/DRAFT.")
        started_bridge.set_response(
            "state.get",
            {
                "state": {"phase": "INTERFACES", "phaseState": "DRAFT"},
                "runtimeHealth": {
                    "nextAction": "author_continue",
                    "shouldContinue": True,
                    "requiresAdapterAction": False,
                    "continuationMessage": "Continue authoring INTERFACES/DRAFT.",
                },
            },
        )

        try:
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
                    {"feedback_type": "approve", "feedback_text": "approved"},
                )
        finally:
            clear_session_project_dir("s1")

        assert result == "Approved. Transitioning to INTERFACES/DRAFT."
        execute_continuation.assert_called_once()
        request = execute_continuation.call_args.args[0]
        routing = request["gatewayRouting"]
        assert routing["platform"] == "discord"
        assert isinstance(routing["chatId"], str) and routing["chatId"]
        assert isinstance(routing["threadId"], str) and routing["threadId"]
        assert routing["userId"] == "941009272429506612"
        assert routing["messageId"] == "msg-1"
        assert isinstance(routing["sessionOrigin"], str) and routing["sessionOrigin"]

    def test_post_tool_stops_at_user_gate_without_continuation(self, started_bridge):
        started_bridge.set_response("tool.execute", "Review accepted. Awaiting user approval.")
        started_bridge.set_response(
            "state.get",
            {
                "state": {"phase": "PLANNING", "phaseState": "USER_GATE"},
                "runtimeHealth": {
                    "nextAction": "stop_user_gate",
                    "shouldContinue": False,
                    "requiresAdapterAction": False,
                    "stopReason": "awaiting user gate at PLANNING",
                    "continuationMessage": None,
                },
            },
        )

        with patch("hermes_adapter.workflow_tools.continuation.execute_continuation") as execute_continuation:
            result = _handle_workflow_tool(
                started_bridge,
                "request_review",
                "s1",
                "/tmp/project",
                {"summary": "done", "artifact_description": "plan"},
            )

        assert result == "Review accepted. Awaiting user approval."
        execute_continuation.assert_not_called()
        assert started_bridge.get_calls("idle.check") == []

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
        assert started_bridge.get_calls("recover_stale_bridge")[0][1]["projectDir"].endswith("/project")
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

    def test_mark_task_complete_dispatches_task_review_immediately(self, started_bridge):
        """Task completion should drain TASK_REVIEW without waiting for another LLM turn."""
        state_calls = 0

        def state_response(params):
            nonlocal state_calls
            if params["sessionId"] != "s1":
                return None
            state_calls += 1
            if state_calls == 1:
                return {"phase": "IMPLEMENTATION", "phaseState": "DRAFT"}
            return {
                "phase": "IMPLEMENTATION",
                "phaseState": "TASK_REVIEW",
                "taskCompletionInProgress": "T1",
            }

        started_bridge.set_response_fn("state.get", state_response)
        started_bridge.set_response("tool.execute", "Task T1 submitted for isolated review.")

        with patch("hermes_adapter.prompt_hook._dispatch_task_review") as dispatch:
            result = _handle_workflow_tool(
                started_bridge,
                "mark_task_complete",
                "s1",
                "/tmp/p",
                {"task_id": "T1", "implementation_summary": "done", "tests_passing": True},
            )

        assert result == "Task T1 submitted for isolated review."
        dispatch.assert_called_once_with(
            started_bridge,
            "s1",
            {
                "phase": "IMPLEMENTATION",
                "phaseState": "TASK_REVIEW",
                "taskCompletionInProgress": "T1",
            },
            "/tmp/p",
        )

    def test_submit_feedback_records_current_user_task_at_user_gate(self, started_bridge):
        """Tool dispatch should mark real gateway user text even when pre_llm_call missed it."""
        def state_response(params):
            if params["sessionId"] == "s1":
                return {
                    "phase": "DISCOVERY",
                    "phaseState": "USER_GATE",
                    "userGateMessageReceived": False,
                }
            return None

        started_bridge.set_response_fn("state.get", state_response)
        started_bridge.set_response("message.process", {"intercepted": True, "parts": []})
        started_bridge.set_response("tool.execute", "Approved discovery.")

        result = _handle_workflow_tool(
            started_bridge,
            "submit_feedback",
            "s1",
            "/tmp/p",
            {"feedback_type": "approve"},
            user_task="approved. keep going until you reach the next user gate",
        )

        assert result == "Approved discovery."
        message_calls = started_bridge.get_calls("message.process")
        assert message_calls == [
            (
                "message.process",
                {
                    "sessionId": "s1",
                    "parts": [
                        {
                            "type": "text",
                            "text": "approved. keep going until you reach the next user gate",
                        }
                    ],
                    "source": "user",
                },
            )
        ]

    def test_submit_feedback_records_current_user_task_at_human_gate(self, started_bridge):
        """HUMAN_GATE resolution still requires real user text before submit_feedback."""
        def state_response(params):
            if params["sessionId"] == "s1":
                return {
                    "phase": "IMPLEMENTATION",
                    "phaseState": "HUMAN_GATE",
                    "userGateMessageReceived": False,
                }
            return None

        started_bridge.set_response_fn("state.get", state_response)
        started_bridge.set_response("message.process", {"intercepted": True, "parts": []})
        started_bridge.set_response("tool.execute", "Resolved 1 human gate(s): T1.")

        result = _handle_workflow_tool(
            started_bridge,
            "submit_feedback",
            "s1",
            "/tmp/p",
            {"feedback_type": "approve", "resolved_human_gates": ["T1"]},
            user_task="T1 is resolved; proceed without cleaning unrelated artifacts",
        )

        assert result == "Resolved 1 human gate(s): T1."
        assert started_bridge.get_calls("message.process") == [
            (
                "message.process",
                {
                    "sessionId": "s1",
                    "parts": [
                        {
                            "type": "text",
                            "text": "T1 is resolved; proceed without cleaning unrelated artifacts",
                        }
                    ],
                    "source": "user",
                },
            )
        ]

    def test_submit_feedback_without_current_user_text_does_not_mark_gate(self, started_bridge):
        started_bridge.set_response(
            "state.get",
            {"phase": "DISCOVERY", "phaseState": "USER_GATE", "userGateMessageReceived": False},
        )
        started_bridge.set_response("tool.execute", "Error: Waiting for user response.")

        _handle_workflow_tool(
            started_bridge,
            "submit_feedback",
            "s1",
            "/tmp/p",
            {"feedback_type": "approve"},
        )

        assert started_bridge.get_calls("message.process") == []

    def test_submit_feedback_uses_last_prompt_user_message_at_user_gate(self, started_bridge):
        """Approval can be captured before the workflow reaches USER_GATE in the same gateway turn."""
        started_bridge.set_response(
            "state.get",
            {"phase": "DISCOVERY", "phaseState": "USER_GATE", "userGateMessageReceived": False},
        )
        started_bridge.set_response("message.process", {"intercepted": True, "parts": []})
        started_bridge.set_response("tool.execute", "Approved discovery.")

        try:
            set_last_user_message("s1", "approved. keep going until the next user gate")
            result = _handle_workflow_tool(
                started_bridge,
                "submit_feedback",
                "s1",
                "/tmp/p",
                {"feedback_type": "approve"},
            )
        finally:
            clear_session_project_dir("s1")

        assert result == "Approved discovery."
        message_calls = started_bridge.get_calls("message.process")
        assert message_calls == [
            (
                "message.process",
                {
                    "sessionId": "s1",
                    "parts": [
                        {
                            "type": "text",
                            "text": "approved. keep going until the next user gate",
                        }
                    ],
                    "source": "user",
                },
            )
        ]

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

    def test_includes_recent_progress_events(self, started_bridge):
        state = {"phase": "IMPLEMENTATION", "phaseState": "TASK_REVISE", "mode": "INCREMENTAL"}
        started_bridge.set_response(
            "state.get",
            {"state": state, "runtimeHealth": {"noopReason": None}},
        )
        started_bridge.set_response(
            "progress.list",
            {
                "events": [
                    {
                        "id": "event-1",
                        "kind": "task-review",
                        "status": "failed",
                        "message": "Review failed",
                    }
                ],
                "nextCursor": "event-1",
            },
        )

        result = _handle_oa_state(started_bridge, "s1")

        parsed = json.loads(result)
        assert parsed["recentProgress"][0]["id"] == "event-1"
        progress_calls = started_bridge.get_calls("progress.list")
        assert progress_calls[0][1]["sessionId"] == "s1"
        assert progress_calls[0][1]["limit"] == 50

    def test_recent_progress_prefers_current_phase(self, started_bridge):
        state = {"phase": "INTERFACES", "phaseState": "REVISE", "mode": "INCREMENTAL"}
        started_bridge.set_response(
            "state.get",
            {"state": state, "runtimeHealth": {"noopReason": None}},
        )
        started_bridge.set_response(
            "progress.list",
            {
                "events": [
                    {
                        "id": "old-user-gate",
                        "phase": "PLANNING",
                        "phaseState": "USER_GATE",
                        "kind": "phase-review",
                        "status": "succeeded",
                        "message": "Planning review accepted",
                    },
                    {
                        "id": "current-review",
                        "phase": "INTERFACES",
                        "phaseState": "REVISE",
                        "kind": "phase-review",
                        "status": "failed",
                        "message": "Interfaces review failed",
                    },
                ],
                "nextCursor": "current-review",
            },
        )

        result = _handle_oa_state(started_bridge, "s1")

        parsed = json.loads(result)
        assert [event["id"] for event in parsed["recentProgress"]] == ["current-review"]

    def test_state_drains_task_review_after_timeout(self, started_bridge):
        """A later oa_state call should reconnect/catch up stuck adapter-owned TASK_REVIEW."""
        call_count = 0

        def state_response(params):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                payload = {
                    "phase": "IMPLEMENTATION",
                    "phaseState": "TASK_REVIEW",
                    "taskCompletionInProgress": "T1",
                }
            else:
                payload = {"phase": "IMPLEMENTATION", "phaseState": "DRAFT", "currentTaskId": "T2"}
            if params.get("includeRuntimeHealth"):
                return {"state": payload, "runtimeHealth": {"noopReason": None}}
            return payload

        started_bridge.set_response_fn("state.get", state_response)

        with patch("hermes_adapter.prompt_hook._dispatch_task_review") as dispatch:
            result = _handle_oa_state(started_bridge, "s1", "/tmp/project")

        dispatch.assert_called_once()
        parsed = json.loads(result)
        assert parsed["phaseState"] == "DRAFT"
        assert parsed["currentTaskId"] == "T2"

    def test_state_drains_task_review_when_completion_field_is_not_visible(self, started_bridge):
        """A summarized TASK_REVIEW state is still adapter-owned and should drain."""
        call_count = 0

        def state_response(params):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                payload = {
                    "phase": "IMPLEMENTATION",
                    "phaseState": "TASK_REVIEW",
                    "currentTaskId": "T1",
                }
            else:
                payload = {"phase": "IMPLEMENTATION", "phaseState": "DRAFT", "currentTaskId": "T2"}
            if params.get("includeRuntimeHealth"):
                return {"state": payload, "runtimeHealth": {"noopReason": None}}
            return payload

        started_bridge.set_response_fn("state.get", state_response)

        with patch("hermes_adapter.prompt_hook._dispatch_task_review") as dispatch:
            result = _handle_oa_state(started_bridge, "s1", "/tmp/project")

        dispatch.assert_called_once()
        parsed = json.loads(result)
        assert parsed["phaseState"] == "DRAFT"
        assert parsed["currentTaskId"] == "T2"

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

    def test_explicitly_selected_project_state_does_not_fallback_to_default(self, started_bridge, tmp_path: Path):
        project_dir = tmp_path / "repo"
        feature_dir = project_dir / ".openartisan" / "feature-a"
        feature_dir.mkdir(parents=True)
        (feature_dir / "workflow-state.json").write_text("{}")

        def state_response(params):
            if params["sessionId"] == "runtime-session":
                return {
                    "state": {"sessionId": "runtime-session", "phase": "MODE_SELECT", "phaseState": "DRAFT"},
                    "runtimeHealth": {"noopReason": None},
                }
            if params["sessionId"] == "default":
                return {
                    "state": {"sessionId": "default", "phase": "IMPLEMENTATION", "phaseState": "HUMAN_GATE"},
                    "runtimeHealth": {"noopReason": None},
                }
            return None

        _handle_select_project(
            started_bridge,
            "runtime-session",
            {"project_dir": str(project_dir)},
        )
        started_bridge.set_response_fn("state.get", state_response)

        result = _handle_oa_state(started_bridge, "runtime-session")

        parsed = json.loads(result)
        assert parsed["sessionId"] == "runtime-session"
        assert parsed["phase"] == "MODE_SELECT"
        state_calls = started_bridge.get_calls("state.get")
        assert state_calls[-1][1]["sessionId"] == "runtime-session"
        assert all(call[1]["sessionId"] != "default" for call in state_calls)


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
