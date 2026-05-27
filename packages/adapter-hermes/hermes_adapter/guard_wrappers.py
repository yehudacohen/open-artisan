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


GUARDED_TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "write_file": {
        "type": "object",
        "properties": {"path": {"type": "string"}, "file_path": {"type": "string"}, "content": {"type": "string"}},
        "additionalProperties": True,
    },
    "create_file": {
        "type": "object",
        "properties": {"path": {"type": "string"}, "file_path": {"type": "string"}, "content": {"type": "string"}},
        "additionalProperties": True,
    },
    "edit_file": {
        "type": "object",
        "properties": {"path": {"type": "string"}, "file_path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}},
        "additionalProperties": True,
    },
    "patch_file": {
        "type": "object",
        "properties": {"path": {"type": "string"}, "file_path": {"type": "string"}, "patch": {"type": "string"}},
        "additionalProperties": True,
    },
    "execute_command": {
        "type": "object",
        "properties": {"command": {"type": "string"}, "cmd": {"type": "string"}, "script": {"type": "string"}},
        "additionalProperties": True,
    },
}


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
    get_tool_handler = getattr(ctx, "get_tool_handler", None)

    for tool_name in GUARDED_TOOLS:
        original = get_tool_handler(tool_name) if callable(get_tool_handler) else None
        if original is None:
            _register_fail_closed_wrapper(ctx, tool_name)
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
                "parameters": GUARDED_TOOL_SCHEMAS.get(tool_name, {"type": "object", "additionalProperties": True}),
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


def _register_fail_closed_wrapper(ctx: HermesContext, tool_name: str) -> None:
    """Register a blocker when a guarded built-in cannot be wrapped."""
    ctx.register_tool(
        name=tool_name,
        toolset=TOOLSET_NAME,
        schema={
            "name": tool_name,
            "description": f"(guarded unavailable) {tool_name}",
            "parameters": GUARDED_TOOL_SCHEMAS.get(tool_name, {"type": "object", "additionalProperties": True}),
        },
        handler=lambda args, _tn=tool_name: _missing_original_handler(_tn, args),
        description=f"(guarded unavailable) {tool_name}",
    )


async def _missing_original_handler(tool_name: str, _args: dict[str, Any]) -> str:
    return make_error_response(
        f"Workflow guard failed closed: Hermes built-in handler for {tool_name} was unavailable, so the write-like tool was not executed."
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
    stripped = command.strip()
    if "\n" in stripped or "\r" in stripped:
        return False
    return ARTISAN_COMMAND_RE.fullmatch(stripped) is not None
