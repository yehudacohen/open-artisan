"""
open-artisan Hermes adapter — plugin entry point.

Registers workflow tools, guard wrappers, and prompt hooks with the
Hermes agent. Manages the bridge subprocess lifecycle.
"""

from __future__ import annotations

import logging
import os
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
    4. Registers workflow tools + oa_state
    5. Registers guard wrappers for file-write tools
    6. Registers pre_llm_call prompt hook

    Args:
        ctx: Hermes plugin context.
    """
    global _bridge
    _bridge = StdioBridgeClient()

    # Register lifecycle hooks
    ctx.register_hook(
        "on_session_start", lambda **kwargs: _on_session_start(ctx, _bridge, **kwargs)
    )
    ctx.register_hook(
        "on_session_end", lambda **kwargs: _on_session_end(ctx, _bridge, **kwargs)
    )

    # Register workflow tools + oa_state
    register_workflow_tools(ctx, _bridge)

    # Register guard wrappers for file-write tools
    register_guard_wrappers(ctx, _bridge)

    # Register per-turn prompt injection hook
    prompt_hook = create_prompt_hook(_bridge, project_dir=os.getcwd())
    ctx.register_hook("pre_llm_call", prompt_hook)

    logger.info("open-artisan plugin registered")


def _on_session_start(
    ctx: HermesContext,
    bridge: BridgeClient,
    **kwargs: Any,
) -> None:
    """Session start handler - eagerly initializes the bridge.

    1. Calls bridge.start(project_dir) to spawn subprocess
    2. Calls lifecycle.sessionCreated to register the session
    """

    try:
        session_id = str(kwargs.get("session_id", "default"))
        project_dir = os.getcwd()
        bridge.start(project_dir)
        bridge.call("lifecycle.sessionCreated", {"sessionId": session_id})
        logger.info("Bridge started for session %s", session_id)
    except Exception as e:
        logger.error("Failed to start bridge: %s", e)


def _on_session_end(
    ctx: HermesContext,
    bridge: BridgeClient,
    **kwargs: Any,
) -> None:
    """Session end handler - gracefully shuts down the bridge.

    1. Calls lifecycle.sessionDeleted
    2. Calls bridge.shutdown()

    Both steps are individually protected - lifecycle hooks must never crash Hermes.
    """

    session_id = str(kwargs.get("session_id", "default"))
    try:
        bridge.call("lifecycle.sessionDeleted", {"sessionId": session_id})
    except Exception as e:
        logger.debug("lifecycle.sessionDeleted failed (bridge may be dead): %s", e)

    try:
        bridge.shutdown()
    except Exception as e:
        logger.debug("bridge.shutdown failed: %s", e)

    logger.info("Bridge shut down for session %s", session_id)
