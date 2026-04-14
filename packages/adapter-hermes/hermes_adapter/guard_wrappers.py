"""
guard_wrappers.py — Wrapper tools that enforce the workflow guard on file writes.

Wraps Hermes built-in tools (write_file, edit_file, create_file, patch_file,
execute_command) with a guard.check call to the bridge. If the guard blocks,
returns a structured error JSON instead of calling the original handler.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Awaitable

from .types import BridgeClient, BridgeError, HermesContext, make_error_response
from .constants import GUARDED_TOOLS, ARTISAN_COMMAND_RE, TOOLSET_NAME


def register_guard_wrappers(
    ctx: HermesContext,
    bridge: BridgeClient,
) -> None:
    """Wrap guarded built-in tools with workflow enforcement.

    For each tool in GUARDED_TOOLS, retrieves the original handler via
    ctx.get_tool_handler(), then re-registers a wrapper that calls
    guard.check before delegating.

    Args:
        ctx: Hermes plugin context for tool registration.
        bridge: Active bridge client for guard.check calls.
    """
    if not hasattr(ctx, "get_tool_handler"):
        return

    for tool_name in GUARDED_TOOLS:
        original = ctx.get_tool_handler(tool_name)
        if original is None:
            # Built-in tool not registered — skip wrapping
            continue

        # Capture tool_name and original in closure
        _tool_name = tool_name
        _original = original
        ctx.register_tool(
            name=tool_name,
            toolset=TOOLSET_NAME,
            schema={
                "name": tool_name,
                "description": f"(guarded) {tool_name}",
                "parameters": {"type": "object", "properties": {}},
            },
            handler=lambda args, _tn=_tool_name, _oh=_original: _guarded_handler(
                bridge,
                _oh,
                _tn,
                ctx.session_id,
                args,
            ),
            description=f"(guarded) {tool_name}",
        )


async def _guarded_handler(
    bridge: BridgeClient,
    original_handler: Callable[..., Awaitable[str]],
    tool_name: str,
    session_id: str,
    args: dict[str, Any],
) -> str:
    """Guard wrapper logic for a single tool call.

    1. For execute_command: check artisan passthrough first
    2. Call guard.check via bridge
    3. If allowed: delegate to original_handler, return its result
    4. If blocked: return structured error JSON (no delegation)
    5. If bridge unreachable: return error JSON (no delegation — fail-closed)

    Args:
        bridge: Active bridge client.
        original_handler: The original Hermes tool handler to delegate to.
        tool_name: Name of the guarded tool (e.g. "write_file").
        session_id: Current session ID for the guard check.
        args: Tool arguments from the LLM.

    Returns:
        Original handler result if allowed, or error JSON string if blocked.
    """
    # Artisan CLI commands bypass the guard — they are workflow operations
    if tool_name == "execute_command":
        command = args.get("command", args.get("cmd", ""))
        if isinstance(command, str) and _is_artisan_command(command):
            return await original_handler(args)

    # Call guard.check
    try:
        result = bridge.call(
            "guard.check",
            {
                "sessionId": session_id,
                "toolName": tool_name,
                "args": args,
            },
        )
    except BridgeError:
        # Fail-closed: never silently allow writes when guard is unreachable
        return make_error_response(
            "Workflow guard unavailable — bridge communication failed. Retrying may help."
        )

    if result is None:
        # Null result = bridge unavailable — fail-closed
        return make_error_response(
            "Workflow guard unavailable — bridge returned no response."
        )

    # Check guard decision
    allowed = result.get("allowed", False) if isinstance(result, dict) else False
    if allowed:
        return await original_handler(args)

    # Blocked — return structured error
    reason = (
        result.get("reason", f"Tool '{tool_name}' blocked by workflow guard.")
        if isinstance(result, dict)
        else f"Tool '{tool_name}' blocked."
    )
    phase = result.get("phase", "") if isinstance(result, dict) else ""
    phase_state = result.get("phaseState", "") if isinstance(result, dict) else ""
    return make_error_response(reason, phase, phase_state)


def _is_artisan_command(command: str) -> bool:
    """Check if an execute_command string is an artisan CLI invocation.

    Artisan commands bypass the guard — they are workflow operations,
    not file writes.

    Args:
        command: The shell command string to check.

    Returns:
        True if the command matches the ARTISAN_COMMAND_RE pattern.
    """
    return ARTISAN_COMMAND_RE.search(command) is not None
