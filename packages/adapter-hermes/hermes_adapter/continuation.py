"""
continuation.py — interface contracts for Hermes autonomous continuation.

This module defines the adapter-level continuation request/result types used to
separate bridge-owned continuation decisions from Hermes-owned continuation
execution.

The implementation phase will wire these contracts into runtime behavior for:
- direct CLI/session continuation inside Hermes-native runtime primitives
- gateway-owned messaging continuation handoff
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import textwrap
from typing import Any, Literal, Protocol, TypedDict, runtime_checkable

from .types import JsonObject

ContinuationSurfaceKind = Literal[
    "direct_cli",
    "gateway_messaging",
    "unknown",
]

ContinuationStrategyKind = Literal[
    "direct_runner",
    "gateway_handoff",
    "none",
]

ContinuationOutcomeKind = Literal[
    "continued",
    "handoff_requested",
    "skipped",
    "blocked",
    "failed",
]

logger = logging.getLogger(__name__)

_GATEWAY_RESPONSE_PHASE_STATES = {"USER_GATE", "ESCAPE_HATCH"}


def should_send_gateway_response_for_workflow_state(state: Any) -> bool:
    """Return true only when a gateway continuation may surface a response.

    If state cannot be inspected, preserve existing Hermes behavior and allow the
    response. When Open Artisan state is available, non-gate phase states must not
    look like valid conversational stopping points.
    """
    if not isinstance(state, dict):
        return True
    if state.get("phase") == "DONE":
        return True
    return state.get("phaseState") in _GATEWAY_RESPONSE_PHASE_STATES


class ContinuationSurface(TypedDict, total=False):
    """Normalized description of where the current Hermes session originated."""

    kind: ContinuationSurfaceKind
    platform: str
    source: str
    reason: str


class GatewayRoutingInfo(TypedDict, total=False):
    """Routing metadata required for gateway-owned continuation delivery."""

    platform: str
    chatId: str
    threadId: str
    userId: str
    messageId: str
    sessionOrigin: str


class ContinuationRequest(TypedDict, total=False):
    """Structured continuation input derived from session-end + idle.check data."""

    sessionId: str
    projectDir: str
    agent: str
    idleAction: str
    message: str
    surface: ContinuationSurface
    gatewayRouting: GatewayRoutingInfo
    workflowState: JsonObject
    rawSessionContext: JsonObject


class ContinuationOutcome(TypedDict, total=False):
    """Structured result returned by continuation strategy implementations."""

    kind: ContinuationOutcomeKind
    strategy: ContinuationStrategyKind
    sessionId: str
    detail: str
    missingFields: list[str]
    error: str


@runtime_checkable
class DirectContinuationRunner(Protocol):
    """Runs same-session continuation for direct CLI-originated Hermes sessions."""

    def run(self, request: ContinuationRequest) -> ContinuationOutcome:
        ...


@runtime_checkable
class GatewayContinuationHandoff(Protocol):
    """Delegates continuation of messaging sessions to gateway-owned execution."""

    def handoff(self, request: ContinuationRequest) -> ContinuationOutcome:
        ...


@runtime_checkable
class ContinuationStrategyResolver(Protocol):
    """Chooses the appropriate continuation strategy for a normalized request."""

    def resolve(self, request: ContinuationRequest) -> ContinuationStrategyKind:
        ...


class NativeSessionDirectContinuationRunner:
    """Launch Hermes-native same-session continuation via AIAgent + SessionDB."""

    def run(self, request: ContinuationRequest) -> ContinuationOutcome:
        session_id = str(request.get("sessionId", ""))
        project_dir = str(request.get("projectDir", ""))
        message = _string_value(request.get("message"))
        python_command = _resolve_python_command()

        if not python_command:
            return {
                "kind": "failed",
                "strategy": "direct_runner",
                "sessionId": session_id,
                "detail": "Python runtime not found for Hermes continuation worker",
                "error": "Python runtime not found for Hermes continuation worker",
            }

        if not message:
            return {
                "kind": "failed",
                "strategy": "direct_runner",
                "sessionId": session_id,
                "detail": "Continuation message missing",
                "error": "Continuation message missing",
            }

        payload = {
            "sessionId": session_id,
            "message": message,
            "platform": _string_value((request.get("surface") or {}).get("platform")) or "cli",
            "userId": _string_value((request.get("gatewayRouting") or {}).get("userId")),
        }

        try:
            _launch_python_worker(
                _DIRECT_CONTINUATION_WORKER,
                payload,
                project_dir=project_dir,
            )
        except Exception as exc:
            logger.warning(
                "Failed to launch Hermes native continuation worker for session %s: %s",
                session_id,
                exc,
            )
            return {
                "kind": "failed",
                "strategy": "direct_runner",
                "sessionId": session_id,
                "detail": "Failed to launch Hermes native continuation worker",
                "error": str(exc),
            }

        return {
            "kind": "continued",
            "strategy": "direct_runner",
            "sessionId": session_id,
            "detail": "Launched Hermes native session continuation worker",
        }


class GatewayBackgroundContinuationHandoff:
    """Launch gateway-owned continuation execution with real delivery semantics."""

    def handoff(self, request: ContinuationRequest) -> ContinuationOutcome:
        session_id = str(request.get("sessionId", ""))
        project_dir = str(request.get("projectDir", ""))
        python_command = _resolve_python_command()
        gateway_routing = request.get("gatewayRouting") or {}
        platform = _string_value(gateway_routing.get("platform")) or "gateway"
        message = _string_value(request.get("message"))

        if not python_command:
            return {
                "kind": "failed",
                "strategy": "gateway_handoff",
                "sessionId": session_id,
                "detail": "Python runtime not found for gateway continuation worker",
                "error": "Python runtime not found for gateway continuation worker",
            }

        if not message:
            return {
                "kind": "failed",
                "strategy": "gateway_handoff",
                "sessionId": session_id,
                "detail": "Continuation message missing",
                "error": "Continuation message missing",
            }

        payload = {
            "sessionId": session_id,
            "message": message,
            "platform": platform,
            "chatId": _string_value(gateway_routing.get("chatId")) or "",
            "threadId": _string_value(gateway_routing.get("threadId")) or "",
            "userId": _string_value(gateway_routing.get("userId")) or "",
            "messageId": _string_value(gateway_routing.get("messageId")) or "",
            "sessionOrigin": _string_value(gateway_routing.get("sessionOrigin")) or "",
            "workflowState": dict(request.get("workflowState") or {}),
        }

        child_env = {
            "OPENARTISAN_CONTINUE_PLATFORM": payload["platform"],
            "OPENARTISAN_CONTINUE_SOURCE": _string_value((request.get("surface") or {}).get("source")) or "gateway",
            "OPENARTISAN_CONTINUE_CHAT_ID": payload["chatId"],
            "OPENARTISAN_CONTINUE_THREAD_ID": payload["threadId"],
            "OPENARTISAN_CONTINUE_USER_ID": payload["userId"],
            "OPENARTISAN_CONTINUE_MESSAGE_ID": payload["messageId"],
            "OPENARTISAN_CONTINUE_SESSION_ORIGIN": payload["sessionOrigin"],
        }

        try:
            _launch_python_worker(
                _GATEWAY_CONTINUATION_WORKER,
                payload,
                project_dir=project_dir,
                extra_env=child_env,
            )
        except Exception as exc:
            logger.warning(
                "Failed to launch %s gateway continuation worker for session %s: %s",
                platform,
                session_id,
                exc,
            )
            return {
                "kind": "failed",
                "strategy": "gateway_handoff",
                "sessionId": session_id,
                "detail": f"Failed to launch {platform} gateway continuation worker",
                "error": str(exc),
            }

        return {
            "kind": "handoff_requested",
            "strategy": "gateway_handoff",
            "sessionId": session_id,
            "detail": f"Launched {platform} gateway continuation worker",
        }


def _resolve_python_command() -> str | None:
    env_python = os.environ.get("OPENARTISAN_PYTHON")
    if env_python:
        return env_python
    if sys.executable:
        return sys.executable
    return shutil.which("python3") or shutil.which("python")


def _resolve_hermes_source_root() -> str:
    env_root = os.environ.get("OPENARTISAN_HERMES_SOURCE")
    if env_root:
        return env_root
    return os.path.expanduser("~/.hermes/hermes-agent")


def _launch_python_worker(
    script: str,
    payload: dict[str, Any],
    *,
    project_dir: str,
    extra_env: dict[str, str] | None = None,
) -> None:
    python_command = _resolve_python_command()
    if not python_command:
        raise RuntimeError("Python runtime not found")

    env = os.environ.copy()
    env["OPENARTISAN_HERMES_SOURCE"] = _resolve_hermes_source_root()
    if extra_env:
        env.update(extra_env)

    subprocess.Popen(
        [python_command, "-c", script, json.dumps(payload)],
        cwd=project_dir or None,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


_DIRECT_CONTINUATION_WORKER = textwrap.dedent(
    """
    import json
    import os
    import sys

    payload = json.loads(sys.argv[1])
    hermes_root = os.environ.get("OPENARTISAN_HERMES_SOURCE")
    if hermes_root and hermes_root not in sys.path:
        sys.path.insert(0, hermes_root)

    from hermes_state import SessionDB
    from run_agent import AIAgent

    db = SessionDB()
    session_id = payload["sessionId"]
    session_row = db.get_session(session_id) or {}
    db.reopen_session(session_id)
    history = db.get_messages_as_conversation(session_id)

    runtime_kwargs = {}
    if session_row.get("billing_provider"):
        runtime_kwargs["provider"] = session_row["billing_provider"]
    if session_row.get("billing_base_url"):
        runtime_kwargs["base_url"] = session_row["billing_base_url"]
    if session_row.get("billing_mode"):
        runtime_kwargs["api_mode"] = session_row["billing_mode"]

    agent = AIAgent(
        model=payload.get("model") or session_row.get("model") or "",
        session_id=session_id,
        platform=payload.get("platform") or "cli",
        user_id=payload.get("userId") or session_row.get("user_id"),
        quiet_mode=True,
        session_db=db,
        persist_session=True,
        **runtime_kwargs,
    )
    agent.run_conversation(
        user_message=payload["message"],
        conversation_history=history,
        system_message=session_row.get("system_prompt"),
        task_id=session_id,
    )
    """
).strip()


_GATEWAY_CONTINUATION_WORKER = textwrap.dedent(
    """
    import asyncio
    import json
    import os
    import sys

    payload = json.loads(sys.argv[1])
    hermes_root = os.environ.get("OPENARTISAN_HERMES_SOURCE")
    if hermes_root and hermes_root not in sys.path:
        sys.path.insert(0, hermes_root)

    from gateway.config import Platform
    from gateway.run import GatewayRunner, _load_gateway_config, _platform_config_key
    from gateway.session import SessionSource
    from hermes_state import SessionDB
    from hermes_cli.tools_config import _get_platform_tools
    from run_agent import AIAgent

    TERMINAL_PHASE_STATES = {"USER_GATE", "ESCAPE_HATCH"}

    def _should_send_gateway_response(state):
        if not isinstance(state, dict):
            return True
        if state.get("phase") == "DONE":
            return True
        return state.get("phaseState") in TERMINAL_PHASE_STATES

    def _candidate_state_paths():
        state_dir = os.path.join(os.getcwd(), ".openartisan")
        paths = []
        workflow_state = payload.get("workflowState")
        feature_name = workflow_state.get("featureName") if isinstance(workflow_state, dict) else None
        if isinstance(feature_name, str) and feature_name:
            paths.append(os.path.join(state_dir, feature_name, "workflow-state.json"))
        try:
            children = os.listdir(state_dir)
        except Exception:
            children = []
        for child in children:
            path = os.path.join(state_dir, child, "workflow-state.json")
            if path not in paths:
                paths.append(path)
        return paths

    def _load_current_workflow_state():
        candidates = []
        for path in _candidate_state_paths():
            try:
                candidates.append((os.path.getmtime(path), path))
            except Exception:
                continue
        for _, path in sorted(candidates, reverse=True):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    state = json.load(handle)
            except Exception:
                continue
            if isinstance(state, dict) and state.get("phase") and state.get("phaseState"):
                return state

        workflow_state = payload.get("workflowState")
        if isinstance(workflow_state, dict) and workflow_state.get("phase") and workflow_state.get("phaseState"):
            return workflow_state
        return None

    async def main() -> None:
        db = SessionDB()
        session_id = payload["sessionId"]
        session_row = db.get_session(session_id) or {}
        db.reopen_session(session_id)
        history = db.get_messages_as_conversation(session_id)

        gateway = GatewayRunner()
        user_config = _load_gateway_config()
        platform = Platform(payload["platform"])
        platform_config = gateway.config.platforms.get(platform)
        if platform_config is None:
            raise RuntimeError(f"Gateway platform not configured: {platform.value}")

        adapter = gateway._create_adapter(platform, platform_config)
        if adapter is None:
            raise RuntimeError(f"Gateway adapter unavailable: {platform.value}")

        connected = await adapter.connect()
        if not connected:
            raise RuntimeError(f"Gateway adapter failed to connect: {platform.value}")

        gateway.adapters[platform] = adapter
        gateway.delivery_router.adapters = gateway.adapters

        source = SessionSource(
            platform=platform,
            chat_id=payload["chatId"],
            user_id=payload.get("userId") or None,
            thread_id=payload.get("threadId") or None,
            chat_type="thread" if payload.get("threadId") else "dm",
        )

        model, runtime_kwargs = gateway._resolve_session_agent_runtime(
            source=source,
            user_config=user_config,
        )
        if not runtime_kwargs.get("api_key"):
            raise RuntimeError(f"No provider credentials configured for {platform.value} continuation")

        platform_key = _platform_config_key(platform)
        enabled_toolsets = sorted(_get_platform_tools(user_config, platform_key))

        agent = AIAgent(
            model=session_row.get("model") or model,
            **runtime_kwargs,
            quiet_mode=True,
            enabled_toolsets=enabled_toolsets,
            session_id=session_id,
            platform=platform.value,
            user_id=payload.get("userId") or session_row.get("user_id"),
            session_db=db,
            persist_session=True,
        )
        result = agent.run_conversation(
            user_message=payload["message"],
            conversation_history=history,
            system_message=session_row.get("system_prompt"),
            task_id=session_id,
        )

        response = result.get("final_response", "") if result else ""
        metadata = {"thread_id": payload["threadId"]} if payload.get("threadId") else None
        reply_to = payload.get("messageId") or None

        media_files, response = adapter.extract_media(response)
        images, text_content = adapter.extract_images(response)

        if not _should_send_gateway_response(_load_current_workflow_state()):
            try:
                await adapter.disconnect()
            except Exception:
                pass
            return

        if text_content:
            await adapter.send(
                chat_id=payload["chatId"],
                content=text_content,
                reply_to=reply_to,
                metadata=metadata,
            )
        elif not images and not media_files:
            await adapter.send(
                chat_id=payload["chatId"],
                content="(No response generated)",
                reply_to=reply_to,
                metadata=metadata,
            )

        for image_url, alt_text in (images or []):
            await adapter.send_image(
                chat_id=payload["chatId"],
                image_url=image_url,
                caption=alt_text,
                reply_to=reply_to,
                metadata=metadata,
            )

        for media_path in (media_files or []):
            await adapter.send_document(
                chat_id=payload["chatId"],
                file_path=media_path,
                reply_to=reply_to,
                metadata=metadata,
            )

        try:
            await adapter.disconnect()
        except Exception:
            pass

    asyncio.run(main())
    """
).strip()


_GATEWAY_PLATFORMS = {"telegram", "discord", "slack", "sms", "whatsapp"}
_GATEWAY_REQUIRED_FIELDS = [
    "chatId",
    "platform",
    "sessionOrigin",
]


def _string_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _gateway_session_env(name: str) -> str:
    try:
        from gateway.session_context import get_session_env
    except Exception:
        return os.environ.get(name, "")
    return get_session_env(name, "")


def _set_if_present(context: dict[str, Any], key: str, value: Any) -> None:
    normalized = _string_value(value)
    if normalized:
        context[key] = normalized


def _parse_gateway_session_key(session_key: str | None) -> dict[str, str]:
    value = _string_value(session_key)
    if not value:
        return {}
    parts = value.split(":")
    if len(parts) < 4 or parts[0] != "agent" or parts[1] != "main":
        return {"session_origin": value}

    parsed = {
        "platform": parts[2],
        "source": "gateway",
        "session_origin": value,
    }
    chat_type = parts[3]
    remaining = parts[4:]

    if chat_type == "dm":
        if remaining:
            parsed["chat_id"] = remaining[0]
        if len(remaining) > 1:
            parsed["thread_id"] = remaining[1]
    else:
        if remaining:
            parsed["chat_id"] = remaining[0]
        if len(remaining) > 1:
            parsed["thread_id"] = remaining[1]

    return parsed


def build_session_context(kwargs: dict[str, Any]) -> dict[str, Any]:
    context: dict[str, Any] = {}
    field_sources = {
        "platform": ("platform", "OPENARTISAN_CONTINUE_PLATFORM", "HERMES_SESSION_PLATFORM"),
        "source": ("source", "OPENARTISAN_CONTINUE_SOURCE", ""),
        "chat_id": ("chat_id", "OPENARTISAN_CONTINUE_CHAT_ID", "HERMES_SESSION_CHAT_ID"),
        "thread_id": ("thread_id", "OPENARTISAN_CONTINUE_THREAD_ID", "HERMES_SESSION_THREAD_ID"),
        "user_id": ("user_id", "OPENARTISAN_CONTINUE_USER_ID", "HERMES_SESSION_USER_ID"),
        "message_id": ("message_id", "OPENARTISAN_CONTINUE_MESSAGE_ID", ""),
        "session_origin": ("session_origin", "OPENARTISAN_CONTINUE_SESSION_ORIGIN", "HERMES_SESSION_KEY"),
    }

    camel_aliases = {
        "chat_id": "chatId",
        "thread_id": "threadId",
        "user_id": "userId",
        "message_id": "messageId",
        "session_origin": "sessionOrigin",
    }

    for key, sources in field_sources.items():
        kwarg_key, openartisan_env, hermes_env = sources
        value = kwargs.get(kwarg_key)
        if value is None and key in camel_aliases:
            value = kwargs.get(camel_aliases[key])
        if value is None and openartisan_env:
            value = os.environ.get(openartisan_env)
        if value is None and hermes_env:
            value = _gateway_session_env(hermes_env)
        _set_if_present(context, key, value)

    parsed_session = _parse_gateway_session_key(_gateway_session_env("HERMES_SESSION_KEY"))
    for key, value in parsed_session.items():
        if key not in context:
            context[key] = value

    if context.get("platform") and context["platform"] != "cli" and "source" not in context:
        context["source"] = "gateway"

    return context


def classify_continuation_surface(
    session_context: JsonObject | dict[str, Any] | None,
) -> ContinuationSurface:
    context = session_context or {}
    platform = _string_value(context.get("platform"))
    source = _string_value(context.get("source"))

    if platform == "cli":
        surface: ContinuationSurface = {"kind": "direct_cli", "platform": platform}
        if source:
            surface["source"] = source
        return surface

    if platform in _GATEWAY_PLATFORMS:
        surface = {"kind": "gateway_messaging", "platform": platform}
        if source:
            surface["source"] = source
        return surface

    surface = {"kind": "unknown"}
    if platform:
        surface["platform"] = platform
        surface["reason"] = "unrecognized platform"
    else:
        surface["reason"] = "missing platform"
    if source:
        surface["source"] = source
    return surface


def _extract_gateway_routing(
    session_context: JsonObject | dict[str, Any] | None,
) -> GatewayRoutingInfo | None:
    context = session_context or {}
    routing: GatewayRoutingInfo = {}

    field_map = {
        "platform": "platform",
        "chat_id": "chatId",
        "thread_id": "threadId",
        "user_id": "userId",
        "message_id": "messageId",
        "session_origin": "sessionOrigin",
    }
    for source_key, target_key in field_map.items():
        value = _string_value(context.get(source_key))
        if value:
            routing[target_key] = value

    return routing or None


def build_continuation_request(
    *,
    session_id: str,
    project_dir: str,
    agent: str,
    idle_decision: JsonObject | dict[str, Any],
    session_context: JsonObject | dict[str, Any] | None,
    workflow_state: JsonObject | dict[str, Any] | None,
) -> ContinuationRequest:
    idle_action = _string_value(idle_decision.get("action"))
    if idle_action != "reprompt":
        raise ValueError("build_continuation_request requires idle.check action 'reprompt'")

    message = _string_value(idle_decision.get("message"))
    if not message:
        raise ValueError("build_continuation_request requires a non-empty idle.check message")

    surface = classify_continuation_surface(session_context)
    request: ContinuationRequest = {
        "sessionId": session_id,
        "projectDir": project_dir,
        "agent": agent,
        "idleAction": idle_action,
        "message": message,
        "surface": surface,
        "workflowState": dict(workflow_state or {}),
        "rawSessionContext": dict(session_context or {}),
    }

    gateway_routing = _extract_gateway_routing(session_context)
    if surface.get("kind") == "gateway_messaging" and gateway_routing:
        request["gatewayRouting"] = gateway_routing

    return request


def resolve_continuation_strategy(request: ContinuationRequest) -> ContinuationStrategyKind:
    surface = request.get("surface") or {}
    surface_kind = surface.get("kind")

    if surface_kind == "direct_cli":
        return "direct_runner"

    if surface_kind == "gateway_messaging":
        gateway_routing = request.get("gatewayRouting") or {}
        if all(_string_value(gateway_routing.get(field)) for field in _GATEWAY_REQUIRED_FIELDS):
            return "gateway_handoff"
        return "none"

    return "none"


def _missing_gateway_fields(request: ContinuationRequest) -> list[str]:
    gateway_routing = request.get("gatewayRouting") or {}
    return [field for field in _GATEWAY_REQUIRED_FIELDS if not _string_value(gateway_routing.get(field))]


def execute_continuation(
    request: ContinuationRequest,
    direct_runner: DirectContinuationRunner,
    gateway_handoff: GatewayContinuationHandoff,
) -> ContinuationOutcome:
    strategy = resolve_continuation_strategy(request)
    session_id = str(request.get("sessionId", ""))

    if strategy == "direct_runner":
        return direct_runner.run(request)

    if strategy == "gateway_handoff":
        return gateway_handoff.handoff(request)

    surface = request.get("surface") or {}
    if surface.get("kind") == "gateway_messaging":
        return {
            "kind": "blocked",
            "strategy": "none",
            "sessionId": session_id,
            "detail": "missing gateway routing metadata",
            "missingFields": _missing_gateway_fields(request),
        }

    return {
        "kind": "skipped",
        "strategy": "none",
        "sessionId": session_id,
        "detail": "no continuation strategy available",
    }
