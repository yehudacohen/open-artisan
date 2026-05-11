"""
open-artisan Hermes adapter — plugin entry point.

Registers workflow tools, guard wrappers, and prompt hooks with the
Hermes agent. Manages the bridge subprocess lifecycle.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from . import continuation, continuation_controller
from .types import HermesContext, BridgeClient
from .bridge_client import StdioBridgeClient
from .workflow_tools import register_workflow_tools
from .guard_wrappers import register_guard_wrappers
from .prompt_hook import create_prompt_hook
from .session_projects import clear_active_session_id, clear_session_project_dir, get_last_session_context, get_session_project_dir, resolve_project_dir, set_active_session_id, set_last_session_context

logger = logging.getLogger(__name__)

# Module-level bridge instance — one per plugin load
_bridge: StdioBridgeClient | None = None
_DEFAULT_AGENT = "hermes"
_interrupt_activity_touch_installed = False
_interrupt_activity_touch_targets: set[type[Any]] = set()
_stale_active_session_recovery_installed = False


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
    _install_interrupt_activity_touch()
    _install_stale_active_session_recovery()

    # Register lifecycle hooks
    ctx.register_hook(
        "on_session_start", lambda **kwargs: _on_session_start(ctx, _bridge, **kwargs)
    )
    ctx.register_hook(
        "on_session_end", lambda **kwargs: _on_session_end(ctx, _bridge, **kwargs)
    )
    ctx.register_hook("pre_tool_call", lambda **kwargs: _on_pre_tool_call(**kwargs))

    # Register workflow tools + oa_state
    register_workflow_tools(ctx, _bridge)

    # Register guard wrappers for file-write tools
    register_guard_wrappers(ctx, _bridge)

    # Register per-turn prompt injection hook
    prompt_hook = create_prompt_hook(_bridge, project_dir=os.getcwd())
    ctx.register_hook("pre_llm_call", prompt_hook)

    logger.info("open-artisan plugin registered")


def _install_interrupt_activity_touch() -> None:
    """Reset Hermes gateway inactivity tracking when user interrupts arrive.

    Gateway approvals at Open Artisan gates can arrive while an older agent run is
    still being monitored for inactivity. Hermes resets timeout tracking from the
    agent's activity summary, not from user messages, so touch the active agent
    when interrupt() is called for a real user message.
    """

    global _interrupt_activity_touch_installed
    patched = False
    for AIAgent in _iter_ai_agent_classes():
        if _install_interrupt_activity_touch_on_class(AIAgent):
            patched = True
    _interrupt_activity_touch_installed = patched


def _iter_ai_agent_classes() -> list[type[Any]]:
    classes: list[type[Any]] = []
    for module_name in ("run_agent", "gateway.run"):
        try:
            module = __import__(module_name, fromlist=["AIAgent"])
        except Exception:
            continue
        candidate = getattr(module, "AIAgent", None)
        if isinstance(candidate, type) and candidate not in classes:
            classes.append(candidate)
    return classes


def _install_interrupt_activity_touch_on_class(AIAgent: type[Any]) -> bool:
    if AIAgent in _interrupt_activity_touch_targets:
        return False

    original_interrupt = getattr(AIAgent, "interrupt", None)
    if not callable(original_interrupt):
        return False
    if getattr(original_interrupt, "_openartisan_activity_touch", False):
        _interrupt_activity_touch_targets.add(AIAgent)
        return False

    def interrupt_with_activity_touch(self: Any, msg: Any = None, *args: Any, **kwargs: Any) -> Any:
        message = str(msg or "")
        if "Execution timed out" not in message:
            touch = getattr(self, "_touch_activity", None)
            if callable(touch):
                try:
                    touch("user interrupt received")
                except Exception:
                    pass
        return original_interrupt(self, msg, *args, **kwargs)

    setattr(interrupt_with_activity_touch, "_openartisan_activity_touch", True)
    setattr(AIAgent, "interrupt", interrupt_with_activity_touch)
    _interrupt_activity_touch_targets.add(AIAgent)
    return True


def _install_stale_active_session_recovery() -> None:
    """Recover Hermes gateway sessions left active after agent timeout.

    BasePlatformAdapter queues follow-up text as an interrupt while a session is
    active. If a timeout path leaves the adapter active but no live gateway agent
    can consume that interrupt, plain messages like "approved" silently queue.
    Patch the gateway busy-session hook to clear stale active markers and spawn
    a fresh turn for the new message.
    """

    global _stale_active_session_recovery_installed
    if _stale_active_session_recovery_installed:
        return
    try:
        module = __import__("gateway.run", fromlist=["GatewayRunner"])
    except Exception:
        return
    GatewayRunner = getattr(module, "GatewayRunner", None)
    original = getattr(GatewayRunner, "_handle_active_session_busy_message", None)
    if not callable(original) or getattr(original, "_openartisan_stale_recovery", False):
        _stale_active_session_recovery_installed = True
        return

    async def handle_active_session_busy_message_with_recovery(self: Any, event: Any, session_key: str) -> bool:
        if _should_recover_stale_active_session(self, event, session_key):
            adapter = getattr(self, "adapters", {}).get(event.source.platform)
            if adapter is not None:
                try:
                    getattr(adapter, "_active_sessions", {}).pop(session_key, None)
                    getattr(adapter, "_pending_messages", {}).pop(session_key, None)
                    getattr(self, "_running_agents", {}).pop(session_key, None)
                    getattr(self, "_running_agents_ts", {}).pop(session_key, None)
                    logger.warning("Recovered stale Hermes active session for %s after inactivity timeout", session_key[:30])
                    await adapter.handle_message(event)
                    return True
                except Exception as exc:
                    logger.debug("Open Artisan stale active-session recovery failed: %s", exc)
        return await original(self, event, session_key)

    setattr(handle_active_session_busy_message_with_recovery, "_openartisan_stale_recovery", True)
    setattr(GatewayRunner, "_handle_active_session_busy_message", handle_active_session_busy_message_with_recovery)
    _stale_active_session_recovery_installed = True


def _should_recover_stale_active_session(runner: Any, event: Any, session_key: str) -> bool:
    if getattr(runner, "_draining", False):
        return False
    adapter = getattr(runner, "adapters", {}).get(event.source.platform)
    active_sessions = getattr(adapter, "_active_sessions", {}) if adapter is not None else {}
    active_event = active_sessions.get(session_key) if isinstance(active_sessions, dict) else None
    running_agents = getattr(runner, "_running_agents", {})
    agent = running_agents.get(session_key) if isinstance(running_agents, dict) else None

    if active_event is not None and getattr(active_event, "is_set", lambda: False)() and agent is None:
        return True
    if agent is None:
        return False
    if not hasattr(agent, "get_activity_summary"):
        return False
    try:
        activity = agent.get_activity_summary()
    except Exception:
        return False
    timeout = _gateway_timeout_seconds()
    if timeout <= 0:
        return False
    try:
        idle = float(activity.get("seconds_since_activity", 0))
    except Exception:
        return False
    return idle >= timeout


def _gateway_timeout_seconds() -> float:
    try:
        return float(os.getenv("HERMES_AGENT_TIMEOUT", "1800"))
    except ValueError:
        return 1800.0


def _on_session_start(
    ctx: HermesContext,
    bridge: BridgeClient,
    **kwargs: Any,
) -> None:
    """Session start handler - initializes only explicitly selected projects.

    Hermes loads plugins for auxiliary/reviewer sessions too. Starting an Open
    Artisan bridge for every session can collide with the active workflow
    session, so ordinary workflow tools lazily initialize the bridge instead.
    """

    try:
        session_id = str(kwargs.get("session_id", "default"))
        set_active_session_id(session_id)
        selected_project_dir = get_session_project_dir(session_id)
        if not selected_project_dir:
            logger.info("Bridge start deferred for session %s", session_id)
            return

        project_dir = resolve_project_dir(session_id, os.getcwd())
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
    clear_active_session_id(session_id)
    project_dir = resolve_project_dir(session_id, str(kwargs.get("cwd") or os.getcwd()))
    idle_decision = _get_idle_decision(bridge, session_id, kwargs)

    if idle_decision and idle_decision.get("action") == "reprompt":
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
                    "source": "session_end_idle",
                    "message": str(idle_decision.get("message") or ""),
                    "sessionContext": _build_session_context_for_session(session_id, kwargs),
                    "workflowState": {},
                    "idleDecision": idle_decision,
                }
            )
        except Exception as e:
            logger.warning(
                "Autonomous continuation failed for session %s: %s",
                session_id,
                e,
            )
        else:
            if outcome.get("kind") in {"continued", "handoff_requested", "duplicate_suppressed"}:
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
    clear_session_project_dir(session_id)

    try:
        bridge.shutdown()
    except Exception as e:
        logger.debug("bridge.shutdown failed: %s", e)

    logger.info("Bridge shut down for session %s", session_id)


def _on_pre_tool_call(**kwargs: Any) -> None:
    session_id = kwargs.get("session_id")
    if isinstance(session_id, str) and session_id:
        set_active_session_id(session_id)
        set_last_session_context(session_id, _build_session_context(kwargs))


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

    fallback_ignore: dict[str, Any] | None = None
    candidate_session_ids = [session_id]
    if session_id != "default":
        # Older/resumed Hermes dogfood sessions can have the active OA workflow
        # persisted under the adapter default session while the gateway runtime
        # reports a platform-specific Hermes session id. Check both so actionable
        # REVISE/DRAFT states cannot be mistaken for a truthful stop.
        candidate_session_ids.append("default")

    for candidate_session_id in candidate_session_ids:
        try:
            result = bridge.call("idle.check", {"sessionId": candidate_session_id})
        except Exception as e:
            logger.debug("idle.check failed for session %s: %s", candidate_session_id, e)
            continue

        if not isinstance(result, dict):
            continue

        if result.get("action") in {"reprompt", "escalate"}:
            if candidate_session_id != session_id:
                logger.info(
                    "Using fallback workflow session %s for autonomous continuation of Hermes session %s",
                    candidate_session_id,
                    session_id,
                )
            return result

        if fallback_ignore is None and result.get("action") == "ignore":
            fallback_ignore = result

    return fallback_ignore


def _detach_session(bridge: BridgeClient, session_id: str, project_dir: str) -> None:
    try:
        bridge.call("lifecycle.sessionDeleted", {"sessionId": session_id})
    except Exception as e:
        logger.debug("lifecycle.sessionDeleted failed (bridge may be dead): %s", e)

    try:
        bridge.clear_session(session_id, project_dir)
    except Exception as e:
        logger.debug("bridge.clear_session failed for session %s: %s", session_id, e)
