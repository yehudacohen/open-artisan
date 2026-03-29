"""
workflow_tools.py — Register the 13 workflow tools + oa_state with Hermes.

Each tool delegates to the bridge via tool.execute (or state.get for oa_state).
All handlers return JSON strings per the Hermes handler contract.
"""
from __future__ import annotations

import json
from typing import Any

from .types import BridgeClient, BridgeError, HermesContext, make_error_response
from .constants import WORKFLOW_TOOLS, OA_STATE_SCHEMA, TOOLSET_NAME


def register_workflow_tools(
    ctx: HermesContext,
    bridge: BridgeClient,
) -> None:
    """Register all workflow tools with the Hermes context.

    Registers 13 tools from WORKFLOW_TOOLS (each delegating to bridge
    tool.execute) plus oa_state (delegating to bridge state.get).

    Args:
        ctx: Hermes plugin context for tool registration.
        bridge: Active bridge client for JSON-RPC calls.
    """
    for hermes_name, bridge_name, description, schema in WORKFLOW_TOOLS:
        # Capture bridge_name in closure
        _bridge_name = bridge_name
        ctx.register_tool(
            toolset=TOOLSET_NAME,
            name=hermes_name,
            description=description,
            parameters=schema,
            handler=lambda args, _bn=_bridge_name: _handle_workflow_tool(
                bridge, _bn, ctx.session_id, ctx.project_dir, args,
            ),
        )

    # oa_state is special — calls state.get directly
    ctx.register_tool(
        toolset=TOOLSET_NAME,
        name="oa_state",
        description=OA_STATE_SCHEMA.get("description", "Show current workflow state."),
        parameters=OA_STATE_SCHEMA,
        handler=lambda args: _handle_oa_state(bridge, ctx.session_id),
    )


async def _handle_workflow_tool(
    bridge: BridgeClient,
    bridge_tool_name: str,
    session_id: str,
    project_dir: str,
    args: dict[str, Any],
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
        result = bridge.call("tool.execute", {
            "name": bridge_tool_name,
            "args": args,
            "context": {
                "sessionId": session_id,
                "directory": project_dir,
            },
        })
        if isinstance(result, str):
            return result
        return json.dumps(result, indent=2)
    except BridgeError as e:
        return make_error_response(
            f"Bridge communication failed: {e}. The workflow server may need to be restarted."
        )


async def _handle_oa_state(
    bridge: BridgeClient,
    session_id: str,
) -> str:
    """Handle oa_state by calling state.get directly.

    Args:
        bridge: Active bridge client.
        session_id: Current Hermes session ID.

    Returns:
        JSON string with current workflow state summary, or error JSON.
    """
    try:
        result = bridge.call("state.get", {"sessionId": session_id})
        if result is None:
            return make_error_response("No active workflow session.")
        return json.dumps(result, indent=2)
    except BridgeError as e:
        return make_error_response(f"Bridge communication failed: {e}")
