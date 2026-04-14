"""
workflow_tools.py — Register the workflow tools + oa_state with Hermes.

Each tool delegates to the bridge via tool.execute (or state.get for oa_state).
All handlers return JSON strings per the Hermes handler contract.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .types import BridgeClient, BridgeError, HermesContext, make_error_response
from .constants import WORKFLOW_TOOLS, OA_STATE_SCHEMA, TOOLSET_NAME


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
            str(kwargs.get("session_id", "default")),
            str(kwargs.get("cwd") or os.getcwd()),
        ),
        description=OA_STATE_SCHEMA.get("description", "Show current workflow state."),
    )


def _handle_workflow_tool(
    bridge: BridgeClient,
    bridge_tool_name: str,
    args: dict[str, Any] | str,
    *rest: Any,
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
            session_id = str(kwargs.get("session_id", "default"))
            project_dir = str(kwargs.get("cwd") or os.getcwd())
            tool_args = args

        bridge.ensure_session(session_id, project_dir)
        result = bridge.call(
            "tool.execute",
            {
                "name": bridge_tool_name,
                "args": tool_args,
                "context": {
                    "sessionId": session_id,
                    "directory": project_dir,
                },
            },
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
        effective_project_dir = project_dir or os.getcwd()
        bridge.ensure_session(session_id or "default", effective_project_dir)
        result = bridge.call("state.get", {"sessionId": session_id or "default"})
        if result is None:
            return make_error_response("No active workflow session.")
        return json.dumps(result, indent=2)
    except BridgeError as e:
        return make_error_response(f"Bridge communication failed: {e}")
