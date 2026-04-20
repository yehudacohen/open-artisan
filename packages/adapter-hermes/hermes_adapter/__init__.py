"""
open-artisan Hermes adapter — plugin entry point.

Registers workflow tools, guard wrappers, and prompt hooks with the
Hermes agent. Manages the bridge subprocess lifecycle.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from . import continuation
from .types import HermesContext, BridgeClient
from .bridge_client import StdioBridgeClient
from .workflow_tools import register_workflow_tools
from .guard_wrappers import register_guard_wrappers
from .prompt_hook import create_prompt_hook

logger = logging.getLogger(__name__)

# Module-level bridge instance — one per plugin load
_bridge: StdioBridgeClient | None = None
_DEFAULT_AGENT = "hermes"


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
        agent = _resolve_agent_name(kwargs)
        bridge.start(project_dir)
        bridge.call(
            "lifecycle.sessionCreated", {"sessionId": session_id, "agent": agent}
        )
        logger.info("Bridge started for session %s (agent=%s)", session_id, agent)
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
    project_dir = str(kwargs.get("cwd") or os.getcwd())
    idle_decision = _get_idle_decision(bridge, session_id, kwargs)

    if idle_decision and idle_decision.get("action") == "reprompt":
        try:
            request = continuation.build_continuation_request(
                session_id=session_id,
                project_dir=project_dir,
                agent=_resolve_agent_name(kwargs),
                idle_decision=idle_decision,
                session_context=_build_session_context(kwargs),
                workflow_state={},
            )
            outcome = continuation.execute_continuation(
                request,
                continuation.NativeSessionDirectContinuationRunner(),
                continuation.GatewayBackgroundContinuationHandoff(),
            )
        except Exception as e:
            logger.warning(
                "Autonomous continuation failed for session %s: %s",
                session_id,
                e,
            )
        else:
            if outcome.get("kind") in {"continued", "handoff_requested"}:
                _detach_session(bridge, session_id, project_dir)
                logger.info(
                    "Autonomous continuation outcome for session %s: %s",
                    session_id,
                    outcome.get("detail", outcome.get("kind", "continued")),
                )
                return
            logger.warning(
                "Autonomous continuation did not proceed for session %s: %s%s",
                session_id,
                outcome.get("detail", outcome.get("kind", "blocked")),
                _format_missing_fields_suffix(outcome),
            )

    if idle_decision and idle_decision.get("action") == "escalate":
        logger.warning(
            "Open Artisan stop condition for session %s: %s",
            session_id,
            idle_decision.get("message", "workflow stalled"),
        )

    _detach_session(bridge, session_id, project_dir)

    try:
        bridge.shutdown()
    except Exception as e:
        logger.debug("bridge.shutdown failed: %s", e)

    logger.info("Bridge shut down for session %s", session_id)


def _build_session_context(kwargs: dict[str, Any]) -> dict[str, Any]:
    context: dict[str, Any] = {}
    env_fallbacks = {
        "platform": "OPENARTISAN_CONTINUE_PLATFORM",
        "source": "OPENARTISAN_CONTINUE_SOURCE",
        "chat_id": "OPENARTISAN_CONTINUE_CHAT_ID",
        "thread_id": "OPENARTISAN_CONTINUE_THREAD_ID",
        "user_id": "OPENARTISAN_CONTINUE_USER_ID",
        "message_id": "OPENARTISAN_CONTINUE_MESSAGE_ID",
        "session_origin": "OPENARTISAN_CONTINUE_SESSION_ORIGIN",
    }
    for key, env_name in env_fallbacks.items():
        value = kwargs.get(key)
        if value is None:
            value = os.environ.get(env_name)
        if value is not None:
            context[key] = value
    return context


def _resolve_agent_name(kwargs: dict[str, Any]) -> str:
    agent = kwargs.get("agent")
    if isinstance(agent, str) and agent.strip():
        return agent.strip()
    return _DEFAULT_AGENT


def _format_missing_fields_suffix(outcome: dict[str, Any]) -> str:
    missing_fields = outcome.get("missingFields")
    if not isinstance(missing_fields, list):
        return ""

    normalized_fields = [field for field in missing_fields if isinstance(field, str) and field]
    if not normalized_fields:
        return ""

    return f"; missing fields: {', '.join(normalized_fields)}"


def _should_attempt_autonomous_continue(kwargs: dict[str, Any]) -> bool:
    if kwargs.get("completed") is False:
        return False
    if bool(kwargs.get("interrupted")):
        return False
    return True


def _get_idle_decision(
    bridge: BridgeClient,
    session_id: str,
    kwargs: dict[str, Any],
) -> dict[str, Any] | None:
    if not _should_attempt_autonomous_continue(kwargs):
        return None

    try:
        result = bridge.call("idle.check", {"sessionId": session_id})
    except Exception as e:
        logger.debug("idle.check failed for session %s: %s", session_id, e)
        return None

    return result if isinstance(result, dict) else None


def _detach_session(bridge: BridgeClient, session_id: str, project_dir: str) -> None:
    try:
        bridge.call("lifecycle.sessionDeleted", {"sessionId": session_id})
    except Exception as e:
        logger.debug("lifecycle.sessionDeleted failed (bridge may be dead): %s", e)

    try:
        bridge.clear_session(session_id, project_dir)
    except Exception as e:
        logger.debug("bridge.clear_session failed for session %s: %s", session_id, e)
