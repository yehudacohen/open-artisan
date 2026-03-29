"""
open-artisan Hermes adapter — plugin entry point.

Registers workflow tools, guard wrappers, and prompt hooks with the
Hermes agent. Manages the bridge subprocess lifecycle.
"""
from __future__ import annotations

import logging
from typing import Any

from .types import HermesContext, BridgeClient, BridgeError
from .bridge_client import StdioBridgeClient
from .workflow_tools import register_workflow_tools
from .guard_wrappers import register_guard_wrappers
from .prompt_hook import create_prompt_hook

logger = logging.getLogger(__name__)

# Module-level bridge instance — one per plugin load
_bridge: StdioBridgeClient | None = None


def register(ctx: HermesContext) -> None:
    """Plugin entry point called by Hermes on load.

    1. Creates a StdioBridgeClient instance
    2. Registers on_session_start hook (eager bridge init)
    3. Registers on_session_end hook (graceful shutdown)
    4. Registers 13 workflow tools + oa_state
    5. Registers guard wrappers for file-write tools
    6. Registers pre_llm_call prompt hook

    Args:
        ctx: Hermes plugin context.
    """
    global _bridge
    _bridge = StdioBridgeClient()

    # Register lifecycle hooks
    ctx.register_hook(
        event="on_session_start",
        handler=lambda: _on_session_start(ctx, _bridge),
    )
    ctx.register_hook(
        event="on_session_end",
        handler=lambda: _on_session_end(ctx, _bridge),
    )

    # Register workflow tools (13 + oa_state)
    register_workflow_tools(ctx, _bridge)

    # Register guard wrappers for file-write tools
    register_guard_wrappers(ctx, _bridge)

    # Register per-turn prompt injection hook
    prompt_hook = create_prompt_hook(_bridge, ctx.session_id, ctx.project_dir)
    ctx.register_hook(event="pre_llm_call", handler=prompt_hook)

    logger.info("open-artisan plugin registered")


async def _on_session_start(
    ctx: HermesContext,
    bridge: BridgeClient,
) -> None:
    """Session start handler — eagerly initializes the bridge.

    1. Calls bridge.start(project_dir) to spawn subprocess
    2. Calls lifecycle.sessionCreated to register the session

    Args:
        ctx: Hermes plugin context (for session_id, project_dir).
        bridge: Bridge client to initialize.
    """
    try:
        bridge.start(ctx.project_dir)
        bridge.call("lifecycle.sessionCreated", {"sessionId": ctx.session_id})
        logger.info("Bridge started for session %s", ctx.session_id)
    except BridgeError as e:
        logger.error("Failed to start bridge: %s", e)


async def _on_session_end(
    ctx: HermesContext,
    bridge: BridgeClient,
) -> None:
    """Session end handler — gracefully shuts down the bridge.

    1. Calls lifecycle.sessionDeleted
    2. Calls bridge.shutdown()

    Args:
        ctx: Hermes plugin context.
        bridge: Bridge client to shut down.
    """
    try:
        bridge.call("lifecycle.sessionDeleted", {"sessionId": ctx.session_id})
    except BridgeError:
        pass  # Best-effort — bridge may already be dead

    bridge.shutdown()
    logger.info("Bridge shut down for session %s", ctx.session_id)
