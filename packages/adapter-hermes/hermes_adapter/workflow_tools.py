"""
workflow_tools.py — Register the workflow tools + oa_state with Hermes.

Each tool delegates to the bridge via tool.execute (or state.get for oa_state).
All handlers return JSON strings per the Hermes handler contract.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from . import continuation
from .types import BridgeClient, BridgeError, HermesContext, make_error_response
from .constants import WORKFLOW_TOOLS, OA_STATE_SCHEMA, TOOLSET_NAME
from .session_projects import (
    discover_openartisan_projects,
    is_openartisan_project,
    resolve_project_dir,
    set_session_project_dir,
)


logger = logging.getLogger(__name__)


def ensure_workflow_session(
    bridge: BridgeClient,
    session_id: str | None,
    project_dir: str | None,
    agent: str = "hermes",
) -> None:
    """Ensure a workflow session exists using the shared adapter contract."""
    effective_project_dir = resolve_project_dir(session_id, project_dir)
    bridge.ensure_session(
        session_id or "default", effective_project_dir, agent=agent
    )


def _state_payload(result: Any) -> dict[str, Any]:
    if isinstance(result, dict) and isinstance(result.get("state"), dict):
        return result["state"]
    if isinstance(result, dict):
        return result
    return {}


def _resolve_workflow_session_state(
    bridge: BridgeClient,
    session_id: str,
    *,
    include_runtime_health: bool = False,
) -> tuple[str, Any]:
    params: dict[str, Any] = {"sessionId": session_id}
    if include_runtime_health:
        params["includeRuntimeHealth"] = True
    result = bridge.call("state.get", params)
    if session_id == "default":
        return session_id, result

    state = _state_payload(result)
    phase = state.get("phase")
    if phase and phase != "MODE_SELECT":
        return session_id, result

    fallback_params: dict[str, Any] = {"sessionId": "default"}
    if include_runtime_health:
        fallback_params["includeRuntimeHealth"] = True
    fallback_result = bridge.call("state.get", fallback_params)
    fallback_state = _state_payload(fallback_result)
    if fallback_state.get("phase") and fallback_state.get("phase") != "MODE_SELECT":
        logger.info(
            "Using fallback workflow session default for Hermes session %s",
            session_id,
        )
        return "default", fallback_result
    return session_id, result


def _build_session_context(kwargs: dict[str, Any]) -> dict[str, Any]:
    return continuation.build_session_context(kwargs)


def _resolve_agent_name(kwargs: dict[str, Any]) -> str:
    agent = kwargs.get("agent")
    if isinstance(agent, str) and agent.strip():
        return agent.strip()
    return "hermes"


def _idle_decision_after_tool(bridge: BridgeClient, session_id: str) -> dict[str, Any] | None:
    fallback_ignore: dict[str, Any] | None = None
    candidate_session_ids = [session_id]
    if session_id != "default":
        candidate_session_ids.append("default")

    for candidate_session_id in candidate_session_ids:
        try:
            result = bridge.call("idle.check", {"sessionId": candidate_session_id})
        except Exception as e:
            logger.debug("post-tool idle.check failed for session %s: %s", candidate_session_id, e)
            continue
        if not isinstance(result, dict):
            continue
        if result.get("action") in {"reprompt", "escalate"}:
            if candidate_session_id != session_id:
                logger.info(
                    "Using fallback workflow session %s for post-tool continuation of Hermes session %s",
                    candidate_session_id,
                    session_id,
                )
            return result
        if fallback_ignore is None and result.get("action") == "ignore":
            fallback_ignore = result
    return fallback_ignore


def _maybe_continue_after_workflow_tool(
    bridge: BridgeClient,
    session_id: str,
    project_dir: str,
    kwargs: dict[str, Any],
    workflow_state: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    decision = _idle_decision_after_tool(bridge, session_id)
    if not isinstance(decision, dict) or decision.get("action") != "reprompt":
        return decision

    try:
        request = continuation.build_continuation_request(
            session_id=session_id,
            project_dir=project_dir,
            agent=_resolve_agent_name(kwargs),
            idle_decision=decision,
            session_context=_build_session_context(kwargs),
            workflow_state=workflow_state or {},
        )
        outcome = continuation.execute_continuation(
            request,
            continuation.NativeSessionDirectContinuationRunner(),
            continuation.GatewayBackgroundContinuationHandoff(),
        )
    except Exception as e:
        logger.warning("Post-tool autonomous continuation failed for session %s: %s", session_id, e)
        return {"action": "reprompt", "continuation": "failed", "error": str(e)}

    if outcome.get("kind") in {"continued", "handoff_requested"}:
        logger.info(
            "Post-tool autonomous continuation outcome for session %s: %s",
            session_id,
            outcome.get("detail", outcome.get("kind", "continued")),
        )
    else:
        logger.warning(
            "Post-tool autonomous continuation did not proceed for session %s: %s",
            session_id,
            outcome.get("detail", outcome.get("kind", "blocked")),
        )
    return {"action": "reprompt", "continuation": outcome}


def register_workflow_tools(
    ctx: HermesContext,
    bridge: BridgeClient,
) -> None:
    """Register all workflow tools with the Hermes context.

    Registers all workflow tools from WORKFLOW_TOOLS (each delegating to bridge
    tool.execute) plus oa_state (delegating to bridge state.get).

    Args:
        ctx: Hermes plugin context for tool registration.
        bridge: Active bridge client for JSON-RPC calls.
    """
    default_session_id = str(getattr(ctx, "session_id", "default") or "default")

    for hermes_name, bridge_name, description, schema in WORKFLOW_TOOLS:
        # Capture bridge_name in closure
        _bridge_name = bridge_name
        ctx.register_tool(
            name=hermes_name,
            toolset=TOOLSET_NAME,
            schema={
                "name": hermes_name,
                "description": description,
                "parameters": schema,
            },
            handler=lambda args, _bn=_bridge_name, **kwargs: _handle_workflow_tool(
                bridge,
                _bn,
                args,
                default_session_id=default_session_id,
                **kwargs,
            ),
            description=description,
        )

    # oa_state is special — calls state.get directly
    ctx.register_tool(
        name="oa_state",
        toolset=TOOLSET_NAME,
        schema={
            "name": "oa_state",
            "description": OA_STATE_SCHEMA.get(
                "description", "Show current workflow state."
            ),
            "parameters": OA_STATE_SCHEMA,
        },
        handler=lambda args, **kwargs: _handle_oa_state(
            bridge,
            str(kwargs.get("session_id") or default_session_id),
            str(kwargs.get("cwd") or os.getcwd()),
        ),
        description=OA_STATE_SCHEMA.get("description", "Show current workflow state."),
    )

    ctx.register_tool(
        name="oa_list_projects",
        toolset=TOOLSET_NAME,
        schema={
            "name": "oa_list_projects",
            "description": "List nearby Open Artisan project directories that can be selected for this Hermes session.",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=lambda args, **kwargs: _handle_list_projects(),
        description="List nearby Open Artisan project directories.",
    )

    ctx.register_tool(
        name="oa_select_project",
        toolset=TOOLSET_NAME,
        schema={
            "name": "oa_select_project",
            "description": "Bind this Hermes session to a specific Open Artisan project directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_dir": {
                        "type": "string",
                        "description": "Absolute or relative path to the Open Artisan project directory.",
                    },
                },
                "required": ["project_dir"],
            },
        },
        handler=lambda args, **kwargs: _handle_select_project(
            bridge,
            str(kwargs.get("session_id") or default_session_id),
            args,
        ),
        description="Bind this session to an Open Artisan project directory.",
    )

    ctx.register_tool(
        name="oa_recover_bridge",
        toolset=TOOLSET_NAME,
        schema={
            "name": "oa_recover_bridge",
            "description": "Clear stale or malformed Open Artisan shared-bridge runtime files for this project.",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=lambda args, **kwargs: _handle_recover_bridge(
            bridge,
            str(kwargs.get("session_id") or default_session_id),
            str(kwargs.get("cwd") or os.getcwd()),
        ),
        description="Recover from stale Open Artisan bridge metadata without supervisor filesystem cleanup.",
    )


def _handle_workflow_tool(
    bridge: BridgeClient,
    bridge_tool_name: str,
    args: dict[str, Any] | str,
    *rest: Any,
    default_session_id: str = "default",
    **kwargs: Any,
) -> str:
    """Dispatch a workflow tool call to the bridge via tool.execute.

    Args:
        bridge: Active bridge client.
        bridge_tool_name: The bridge-side tool name (e.g. "select_mode").
        session_id: Current Hermes session ID.
        project_dir: Project directory path.
        args: Tool arguments from the LLM.

    Returns:
        JSON string result from the bridge, or a structured error JSON
        if bridge communication fails.
    """
    try:
        if rest:
            session_id = str(args)
            project_dir = str(rest[0]) if len(rest) > 0 else os.getcwd()
            tool_args = rest[1] if len(rest) > 1 else kwargs.get("args", {})
            if not isinstance(tool_args, dict):
                raise TypeError("args must be a dict")
        elif isinstance(args, str):
            session_id = str(args)
            project_dir = str(kwargs.get("project_dir") or os.getcwd())
            tool_args = kwargs.get("args", {})
            if not isinstance(tool_args, dict):
                raise TypeError("args must be a dict")
        else:
            session_id = str(kwargs.get("session_id") or default_session_id)
            project_dir = resolve_project_dir(session_id, str(kwargs.get("cwd") or os.getcwd()))
            tool_args = args

        ensure_workflow_session(bridge, session_id, project_dir)
        workflow_session_id, state_result = _resolve_workflow_session_state(
            bridge,
            session_id,
        )
        if bridge_tool_name == "mark_satisfied":
            state = _state_payload(state_result)
            if isinstance(state, dict) and state.get("phaseState") == "REVIEW":
                return make_error_response(
                    "oa_mark_satisfied is disabled in Hermes REVIEW state. "
                    "The isolated phase reviewer is dispatched automatically; wait for it to submit the review result."
                )
        if bridge_tool_name == "submit_feedback":
            feedback_text = tool_args.get("feedback_text")
            message_text = (
                feedback_text.strip() if isinstance(feedback_text, str) else ""
            )
            if not message_text:
                message_text = "(user invoked submit_feedback via Hermes)"
            bridge.call(
                "message.process",
                {
                    "sessionId": workflow_session_id,
                    "parts": [{"type": "text", "text": message_text}],
                },
            )
        result = bridge.call(
            "tool.execute",
            {
                "name": bridge_tool_name,
                "args": tool_args,
                "context": {
                    "sessionId": workflow_session_id,
                    "directory": project_dir,
                },
            },
        )
        if bridge_tool_name == "request_review":
            state = bridge.call("state.get", {"sessionId": workflow_session_id})
            if isinstance(state, dict) and state.get("phaseState") == "REVIEW":
                # request_review can move the workflow into REVIEW in the middle of
                # a tool-use turn. Hermes pre_llm_call will not fire again until the
                # next model turn, so dispatch the isolated phase reviewer here too.
                from .prompt_hook import dispatch_phase_review

                dispatch_phase_review(bridge, workflow_session_id, state, project_dir)
        if bridge_tool_name != "mark_satisfied":
            _maybe_continue_after_workflow_tool(
                bridge,
                session_id,
                project_dir,
                kwargs,
                _state_payload(state_result),
            )
        if isinstance(result, str):
            return result
        return json.dumps(result, indent=2)
    except BridgeError as e:
        return make_error_response(
            f"Bridge communication failed: {e}. The workflow server may need to be restarted."
        )


def _handle_oa_state(
    bridge: BridgeClient,
    session_id: str | None,
    project_dir: str | None = None,
) -> str:
    """Handle oa_state by calling state.get directly.

    Args:
        bridge: Active bridge client.
        session_id: Current Hermes session ID.

    Returns:
        JSON string with current workflow state summary, or error JSON.
    """
    try:
        effective_project_dir = resolve_project_dir(session_id, project_dir or os.getcwd())
        ensure_workflow_session(bridge, session_id, effective_project_dir)
        workflow_session_id, result = _resolve_workflow_session_state(
            bridge,
            session_id or "default",
            include_runtime_health=True,
        )
        if result is None:
            return make_error_response("No active workflow session.")
        if isinstance(result, dict) and isinstance(result.get("state"), dict):
            merged = dict(result["state"])
            merged["runtimeHealth"] = result.get("runtimeHealth")
            return json.dumps(merged, indent=2)
        return json.dumps(result, indent=2)
    except BridgeError as e:
        return make_error_response(f"Bridge communication failed: {e}")


def _handle_list_projects() -> str:
    projects = discover_openartisan_projects()
    return json.dumps({"projects": projects}, indent=2)


def _handle_select_project(
    bridge: BridgeClient,
    session_id: str,
    args: dict[str, Any] | str,
) -> str:
    project_dir = ""
    if isinstance(args, dict):
        value = args.get("project_dir")
        if isinstance(value, str):
            project_dir = value
    if not project_dir:
        return make_error_response("project_dir is required")

    resolved = os.path.abspath(os.path.expanduser(project_dir))
    if not os.path.isdir(resolved):
        return make_error_response(f"Project directory does not exist: {resolved}")
    if not is_openartisan_project(resolved):
        return make_error_response(
            f"Directory is not an Open Artisan project (missing .openartisan/): {resolved}"
        )

    selected = set_session_project_dir(session_id, resolved)
    bridge.start(selected)
    ensure_workflow_session(bridge, session_id, selected)
    return json.dumps(
        {
            "selectedProjectDir": selected,
            "sessionId": session_id,
            "message": "Hermes session is now bound to this Open Artisan project.",
        },
        indent=2,
    )


def _handle_recover_bridge(
    bridge: BridgeClient,
    session_id: str | None,
    project_dir: str | None = None,
) -> str:
    try:
        effective_project_dir = resolve_project_dir(session_id, project_dir or os.getcwd())
        result = bridge.recover_stale_bridge(effective_project_dir)
        return json.dumps(result, indent=2)
    except BridgeError as e:
        return make_error_response(f"Bridge recovery failed: {e}")
