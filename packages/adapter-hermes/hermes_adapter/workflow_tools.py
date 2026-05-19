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

from . import continuation, continuation_controller
from .types import BridgeClient, BridgeError, HermesContext, make_error_response
from .constants import WORKFLOW_TOOLS, OA_STATE_SCHEMA, TOOLSET_NAME
from .session_projects import (
    discover_openartisan_projects,
    get_active_session_id,
    get_last_session_context,
    get_last_user_message,
    has_explicit_session_project,
    is_openartisan_project,
    resolve_project_dir,
    set_session_project_dir,
)


logger = logging.getLogger(__name__)

_SESSION_LOCAL_WORKFLOW_TOOLS = {"check_prior_workflow", "select_mode"}
_MAX_POST_TOOL_STRUCTURAL_STEPS = 6


def _resolve_tool_session_id(kwargs: dict[str, Any], default_session_id: str) -> str:
    explicit = kwargs.get("session_id")
    if isinstance(explicit, str) and explicit:
        return explicit
    if default_session_id and default_session_id != "default":
        return default_session_id
    active = get_active_session_id()
    if active:
        return active
    return default_session_id or "default"


def _extract_current_user_text(kwargs: dict[str, Any]) -> str | None:
    for key in ("user_task", "user_message", "message", "prompt", "input"):
        value = kwargs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _record_user_gate_message_if_needed(
    bridge: BridgeClient,
    session_id: str,
    state: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    if state.get("phaseState") not in {"USER_GATE", "ESCAPE_HATCH", "HUMAN_GATE"}:
        return
    if state.get("userGateMessageReceived") is True:
        return
    user_text = _extract_current_user_text(kwargs)
    if not user_text:
        user_text = get_last_user_message(session_id)
    if not user_text:
        return
    bridge.call(
        "message.process",
        {
            "sessionId": session_id,
            "parts": [{"type": "text", "text": user_text}],
            "source": "user",
        },
    )


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


def _runtime_health_payload(result: Any) -> dict[str, Any]:
    if isinstance(result, dict) and isinstance(result.get("runtimeHealth"), dict):
        return result["runtimeHealth"]
    return {}


def _state_get_with_health(bridge: BridgeClient, session_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    result = bridge.call("state.get", {"sessionId": session_id, "includeRuntimeHealth": True})
    return _state_payload(result), _runtime_health_payload(result)


def _fallback_next_action(state: dict[str, Any]) -> dict[str, Any]:
    phase = str(state.get("phase") or "MODE_SELECT")
    phase_state = str(state.get("phaseState") or "DRAFT")
    if phase == "DONE":
        return {"nextAction": "stop_done", "shouldContinue": False, "requiresAdapterAction": False, "stopReason": "workflow is complete"}
    if phase_state == "USER_GATE":
        return {"nextAction": "stop_user_gate", "shouldContinue": False, "requiresAdapterAction": False, "stopReason": f"awaiting user gate at {phase}"}
    if phase_state == "HUMAN_GATE":
        return {"nextAction": "stop_human_gate", "shouldContinue": False, "requiresAdapterAction": False, "stopReason": f"awaiting human gate at {phase}"}
    if phase_state == "ESCAPE_HATCH":
        return {"nextAction": "stop_escape_hatch", "shouldContinue": False, "requiresAdapterAction": False, "stopReason": f"escape hatch at {phase}"}
    if phase == "IMPLEMENTATION" and phase_state == "TASK_REVIEW":
        return {"nextAction": "adapter_drain", "shouldContinue": True, "requiresAdapterAction": True, "continuationMessage": "Dispatch isolated task review."}
    if phase_state == "REVIEW":
        return {"nextAction": "adapter_drain", "shouldContinue": True, "requiresAdapterAction": True, "continuationMessage": f"Dispatch isolated phase review for {phase}."}
    if phase_state in {"DRAFT", "REDRAFT", "REVISE"} or (phase == "IMPLEMENTATION" and phase_state == "TASK_REVISE"):
        return {
            "nextAction": "author_continue",
            "shouldContinue": True,
            "requiresAdapterAction": False,
            "continuationMessage": f"Continue authoring {phase}/{phase_state}. Do not stop until a real user gate or runtime error.",
        }
    return {"nextAction": "stop_error", "shouldContinue": False, "requiresAdapterAction": False, "stopReason": f"No continuation rule for {phase}/{phase_state}"}


def _next_action(health: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    if isinstance(health.get("nextAction"), str):
        return health
    return _fallback_next_action(state)


def _recent_progress_events(
    bridge: BridgeClient,
    session_id: str,
    current_state: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    try:
        result = bridge.call("progress.list", {"sessionId": session_id, "limit": 50})
    except Exception:
        logger.debug("progress.list failed for session %s", session_id, exc_info=True)
        return []
    if not isinstance(result, dict) or not isinstance(result.get("events"), list):
        return []
    events = [event for event in result["events"] if isinstance(event, dict)]
    phase = current_state.get("phase") if isinstance(current_state, dict) else None
    if isinstance(phase, str) and phase:
        current_phase_events = [event for event in events if event.get("phase") == phase]
        if current_phase_events:
            events = current_phase_events
    return events[-20:]


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


def _build_session_context_for_session(session_id: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    current = continuation.build_session_context(kwargs)
    stored = get_last_session_context(session_id) or {}
    return {**stored, **current}


def _resolve_agent_name(kwargs: dict[str, Any]) -> str:
    agent = kwargs.get("agent")
    if isinstance(agent, str) and agent.strip():
        return agent.strip()
    return "hermes"


def _continue_authoring_from_state(
    bridge: BridgeClient,
    session_id: str,
    project_dir: str,
    kwargs: dict[str, Any],
    state: dict[str, Any],
    action: dict[str, Any],
) -> dict[str, Any]:
    message = str(action.get("continuationMessage") or "Continue the Open Artisan workflow until the next real user gate or runtime error.")
    try:
        controller = continuation_controller.create_continuation_controller(
            state_dir=os.path.join(project_dir, ".openartisan")
        )
        outcome = controller.continue_authoring(
            {
                "bridge": bridge,
                "authorSessionId": session_id,
                "workflowSessionId": session_id,
                "projectDir": project_dir,
                "agent": _resolve_agent_name(kwargs),
                "source": "post_tool",
                "message": message,
                "sessionContext": _build_session_context_for_session(session_id, kwargs),
                "workflowState": state,
                "runtimeHealth": action,
            }
        )
    except Exception as e:
        logger.warning("Structural autonomous continuation failed for session %s: %s", session_id, e)
        return {"action": "author_continue", "continuation": "failed", "error": str(e)}

    if outcome.get("kind") in {"continued", "handoff_requested", "duplicate_suppressed"}:
        logger.info(
            "Structural autonomous continuation outcome for session %s: %s",
            session_id,
            outcome.get("detail", outcome.get("kind", "continued")),
        )
    else:
        logger.warning(
            "Structural autonomous continuation did not proceed for session %s: %s",
            session_id,
            outcome.get("detail", outcome.get("kind", "blocked")),
        )
    return {"action": "author_continue", "continuation": outcome}


def _advance_after_workflow_tool(
    bridge: BridgeClient,
    author_session_id: str,
    workflow_session_id: str,
    project_dir: str,
    kwargs: dict[str, Any],
) -> dict[str, Any] | None:
    """Advance through structural non-user states after a workflow tool returns.

    Adapter-owned states are drained synchronously. Authoring states launch a
    continuation worker and return; that worker will repeat this same structural
    check after any follow-up workflow tool calls.
    """
    last_state: dict[str, Any] | None = None
    for _ in range(_MAX_POST_TOOL_STRUCTURAL_STEPS):
        state, health = _state_get_with_health(bridge, workflow_session_id)
        if not state:
            return {"action": "stop_error", "error": "workflow state unavailable"}
        last_state = state
        action = _next_action(health, state)
        next_action = action.get("nextAction")

        if next_action == "adapter_drain":
            drained_state = _drain_adapter_actions(bridge, workflow_session_id, project_dir)
            if drained_state == state:
                return {"action": "adapter_drain", "state": state}
            continue

        if next_action == "author_continue":
            return _continue_authoring_from_state(
                bridge,
                author_session_id,
                project_dir,
                kwargs,
                state,
                action,
            )

        return {"action": next_action, "stopReason": action.get("stopReason"), "state": state}

    logger.warning(
        "Stopped structural post-tool advancement for session %s after %s step(s); last state=%s/%s",
        workflow_session_id,
        _MAX_POST_TOOL_STRUCTURAL_STEPS,
        (last_state or {}).get("phase"),
        (last_state or {}).get("phaseState"),
    )
    return {"action": "stop_error", "error": "structural post-tool advancement limit reached", "state": last_state or {}}


def _drain_adapter_actions(
    bridge: BridgeClient,
    session_id: str,
    project_dir: str,
    *,
    max_iterations: int = 3,
) -> dict[str, Any] | None:
    """Run bridge-required adapter actions without waiting for another LLM turn.

    Workflow tools can move state into gates that only the adapter can satisfy,
    such as IMPLEMENTATION/TASK_REVIEW or phase REVIEW. Hermes may not issue a
    follow-up pre_llm_call after a tool response, so drain those actions here.
    """
    latest_state: dict[str, Any] | None = None
    dispatched_actions: set[tuple[str, str, str]] = set()
    for _ in range(max_iterations):
        state = bridge.call("state.get", {"sessionId": session_id})
        if not isinstance(state, dict):
            return latest_state
        latest_state = state

        if state.get("taskCompletionInProgress") or state.get("phaseState") == "TASK_REVIEW":
            action_key = (
                "task-review",
                str(state.get("phase", "")),
                str(state.get("taskCompletionInProgress") or state.get("currentTaskId") or "pending"),
            )
            if action_key in dispatched_actions:
                return state
            dispatched_actions.add(action_key)
            from .prompt_hook import _dispatch_task_review

            _dispatch_task_review(bridge, session_id, state, project_dir)
            continue

        if state.get("phaseState") == "REVIEW":
            action_key = (
                "phase-review",
                str(state.get("phase", "")),
                str(state.get("phaseState", "")),
            )
            if action_key in dispatched_actions:
                return state
            dispatched_actions.add(action_key)
            from .prompt_hook import dispatch_phase_review

            dispatch_phase_review(bridge, session_id, state, project_dir)
            continue

        return state

    logger.warning(
        "Stopped draining adapter actions for session %s after %s iteration(s)",
        session_id,
        max_iterations,
    )
    return latest_state


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
                _resolve_tool_session_id(kwargs, default_session_id),
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
            _resolve_tool_session_id(kwargs, default_session_id),
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
            _resolve_tool_session_id(kwargs, default_session_id),
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
            session_id = _resolve_tool_session_id(kwargs, default_session_id)
            project_dir = resolve_project_dir(session_id, str(kwargs.get("cwd") or os.getcwd()))
            tool_args = args

        ensure_workflow_session(bridge, session_id, project_dir)
        if bridge_tool_name in _SESSION_LOCAL_WORKFLOW_TOOLS:
            workflow_session_id = session_id
            state_result = bridge.call("state.get", {"sessionId": session_id})
        else:
            workflow_session_id, state_result = _resolve_workflow_session_state(
                bridge,
                session_id,
            )
        if bridge_tool_name in {"mark_satisfied", "submit_task_review", "submit_phase_review", "submit_review_rubric_item", "submit_auto_approve"}:
            return make_error_response(
                f"oa_{bridge_tool_name} is reserved for isolated reviewers. "
                "Wait for the adapter hook to submit the review result."
            )
        if bridge_tool_name == "submit_feedback":
            _record_user_gate_message_if_needed(
                bridge,
                workflow_session_id,
                _state_payload(state_result),
                kwargs,
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
        if not (isinstance(result, str) and result.startswith("Error:")):
            _advance_after_workflow_tool(
                bridge,
                session_id,
                workflow_session_id,
                project_dir,
                kwargs,
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
        requested_session_id = session_id or "default"
        if has_explicit_session_project(requested_session_id):
            workflow_session_id = requested_session_id
            result = bridge.call(
                "state.get",
                {"sessionId": workflow_session_id, "includeRuntimeHealth": True},
            )
        else:
            workflow_session_id, result = _resolve_workflow_session_state(
                bridge,
                requested_session_id,
                include_runtime_health=True,
            )
        current_state = _state_payload(result)
        needs_adapter_action = (
            bool(current_state.get("taskCompletionInProgress"))
            or current_state.get("phaseState") in {"TASK_REVIEW", "REVIEW"}
        )
        if needs_adapter_action and _drain_adapter_actions(bridge, workflow_session_id, effective_project_dir) is not None:
            result = bridge.call(
                "state.get",
                {"sessionId": workflow_session_id, "includeRuntimeHealth": True},
            )
            current_state = _state_payload(result)
        if result is None:
            return make_error_response("No active workflow session.")
        progress_events = _recent_progress_events(bridge, workflow_session_id, current_state)
        if isinstance(result, dict) and isinstance(result.get("state"), dict):
            merged = dict(result["state"])
            merged["runtimeHealth"] = result.get("runtimeHealth")
            if progress_events:
                merged["recentProgress"] = progress_events
            return json.dumps(merged, indent=2)
        if isinstance(result, dict) and progress_events:
            result = {**result, "recentProgress": progress_events}
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

    selected = set_session_project_dir(session_id, resolved, explicit=True)
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
