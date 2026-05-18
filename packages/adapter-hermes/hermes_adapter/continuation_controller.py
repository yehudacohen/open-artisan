"""Continuation lifecycle coordination for Open Artisan Hermes sessions."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Protocol, TypedDict, runtime_checkable
from uuid import uuid4

from . import continuation
from .continuation import (
    ContinuationOutcome,
    ContinuationStrategyKind,
    ContinuationSurfaceKind,
    DirectContinuationRunner,
    GatewayContinuationHandoff,
    GatewayRoutingInfo,
)
from .types import BridgeClient, JsonObject

logger = logging.getLogger(__name__)

ContinuationControllerSource = Literal["post_tool", "session_end_idle"]
ContinuationLeaseStatus = Literal[
    "pending",
    "launching",
    "running",
    "handoff_requested",
    "duplicate_suppressed",
    "interrupted",
    "blocked",
    "failed",
    "completed",
    "expired",
]
ContinuationControllerOutcomeKind = Literal[
    "continued",
    "handoff_requested",
    "duplicate_suppressed",
    "blocked",
    "failed",
    "skipped",
    "interrupted",
]

_ACTIVE_STATUSES = {"pending", "launching", "running", "handoff_requested", "interrupted"}
_DIAGNOSTIC_LIMIT = 500


class ContinuationControllerRequest(TypedDict, total=False):
    bridge: BridgeClient
    authorSessionId: str
    workflowSessionId: str
    projectDir: str
    agent: str
    source: ContinuationControllerSource
    message: str
    sessionContext: JsonObject
    workflowState: JsonObject
    runtimeHealth: JsonObject
    idleDecision: JsonObject


class ContinuationLease(TypedDict, total=False):
    leaseId: str
    sessionId: str
    workflowSessionId: str
    projectDir: str
    featureName: str | None
    phase: str
    phaseState: str
    taskId: str
    stateFingerprint: str
    source: ContinuationControllerSource
    strategy: ContinuationStrategyKind
    surfaceKind: ContinuationSurfaceKind
    status: ContinuationLeaseStatus
    ownerPid: int
    workerPid: int
    createdAt: str
    updatedAt: str
    lastHeartbeatAt: str
    gatewayRouting: GatewayRoutingInfo
    continuationMessage: str
    interruptRequestedAt: str
    interruptMessage: str
    error: str


class ContinuationControllerOutcome(TypedDict, total=False):
    kind: ContinuationControllerOutcomeKind
    sessionId: str
    workflowSessionId: str
    stateFingerprint: str
    detail: str
    leaseId: str
    strategy: ContinuationStrategyKind
    workerPid: int
    missingFields: list[str]
    error: str
    suppressResponse: bool
    outcome: ContinuationOutcome


class ContinuationInterruptRequest(TypedDict, total=False):
    sessionId: str
    workflowSessionId: str
    projectDir: str
    message: str
    sessionContext: JsonObject
    gatewayRouting: GatewayRoutingInfo
    receivedAt: str


class ContinuationResponseDecision(TypedDict, total=False):
    allow: bool
    reason: str
    leaseId: str
    stateFingerprint: str
    phase: str
    phaseState: str
    status: ContinuationLeaseStatus


@runtime_checkable
class ContinuationController(Protocol):
    def continue_authoring(self, request: ContinuationControllerRequest) -> ContinuationControllerOutcome:
        ...

    def record_interrupt(self, request: ContinuationInterruptRequest) -> ContinuationControllerOutcome:
        ...

    def should_send_gateway_response(
        self,
        session_id: str,
        session_context: JsonObject | dict[str, Any] | None,
        workflow_state: JsonObject | dict[str, Any] | None,
    ) -> ContinuationResponseDecision:
        ...


@runtime_checkable
class ContinuationLeaseStore(Protocol):
    def read(self, session_id: str, state_fingerprint: str | None = None) -> ContinuationLease | None:
        ...

    def create(self, lease: ContinuationLease) -> ContinuationLease:
        ...

    def update(self, lease: ContinuationLease) -> ContinuationLease:
        ...

    def expire(self, lease: ContinuationLease, reason: str) -> ContinuationLease:
        ...


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _string_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _safe_segment(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in value)
    return cleaned[:120] or "unknown"


def _truncate(value: str) -> str:
    return value[:_DIAGNOSTIC_LIMIT]


def build_state_fingerprint(workflow_state: JsonObject | dict[str, Any], continuation_message: str) -> str:
    fields = {
        "featureName": workflow_state.get("featureName"),
        "phase": workflow_state.get("phase"),
        "phaseState": workflow_state.get("phaseState"),
        "currentTaskId": workflow_state.get("currentTaskId"),
        "taskCompletionInProgress": workflow_state.get("taskCompletionInProgress"),
        "messageHash": hashlib.sha256(continuation_message.encode("utf-8")).hexdigest()[:16],
    }
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode("utf-8")).hexdigest()[:24]


def is_active_lease(lease: ContinuationLease, state_fingerprint: str) -> bool:
    if lease.get("stateFingerprint") != state_fingerprint or lease.get("status") not in _ACTIVE_STATUSES:
        return False
    if lease.get("status") in {"running", "handoff_requested", "interrupted"}:
        return isinstance(lease.get("workerPid"), int) and lease["workerPid"] > 0
    return True


class JsonContinuationLeaseStore:
    def __init__(self, state_dir: str) -> None:
        self.state_dir = Path(state_dir)

    def _path(self, session_id: str) -> Path:
        return self.state_dir / "continuation" / f"{_safe_segment(session_id)}.json"

    def read(self, session_id: str, state_fingerprint: str | None = None) -> ContinuationLease | None:
        path = self._path(session_id)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except Exception:
            logger.debug("Failed to read continuation lease %s", path, exc_info=True)
            return None
        if not isinstance(data, dict):
            return None
        lease = data  # type: ignore[assignment]
        if state_fingerprint and lease.get("stateFingerprint") != state_fingerprint:
            return None
        return lease

    def create(self, lease: ContinuationLease) -> ContinuationLease:
        return self.update(lease)

    def update(self, lease: ContinuationLease) -> ContinuationLease:
        session_id = str(lease.get("sessionId") or "default")
        lease["updatedAt"] = _now()
        path = self._path(session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(lease, indent=2, sort_keys=True), encoding="utf-8")
        return lease

    def expire(self, lease: ContinuationLease, reason: str) -> ContinuationLease:
        lease["status"] = "expired"
        lease["error"] = _truncate(reason)
        return self.update(lease)


class DefaultContinuationController:
    def __init__(
        self,
        *,
        lease_store: ContinuationLeaseStore,
        direct_runner: DirectContinuationRunner,
        gateway_handoff: GatewayContinuationHandoff,
    ) -> None:
        self.lease_store = lease_store
        self.direct_runner = direct_runner
        self.gateway_handoff = gateway_handoff

    def continue_authoring(self, request: ContinuationControllerRequest) -> ContinuationControllerOutcome:
        session_id = _string_value(request.get("authorSessionId")) or _string_value(request.get("sessionId")) or "default"
        workflow_session_id = _string_value(request.get("workflowSessionId")) or session_id
        message = _string_value(request.get("message"))
        if not message:
            return _outcome("failed", session_id, workflow_session_id, "", "Continuation message missing", error="Continuation message missing")

        workflow_state = dict(request.get("workflowState") or {})
        fingerprint_state = {
            **workflow_state,
            "sessionContext": dict(request.get("sessionContext") or {}),
        }
        state_fingerprint = build_state_fingerprint(fingerprint_state, message)
        existing = self.lease_store.read(session_id, state_fingerprint)
        if existing and is_active_lease(existing, state_fingerprint):
            existing["status"] = "duplicate_suppressed"
            self.lease_store.update(existing)
            self._emit_progress(request, "continuation.duplicate", "blocked", "Duplicate continuation suppressed", existing)
            return _outcome(
                "duplicate_suppressed",
                session_id,
                workflow_session_id,
                state_fingerprint,
                "Duplicate continuation suppressed",
                lease_id=existing.get("leaseId"),
                strategy=existing.get("strategy"),
                suppress_response=True,
            )

        continuation_request = continuation.build_continuation_request(
            session_id=session_id,
            project_dir=str(request.get("projectDir") or ""),
            agent=str(request.get("agent") or "hermes"),
            idle_decision={"action": "reprompt", "message": message},
            session_context=dict(request.get("sessionContext") or {}),
            workflow_state=workflow_state,
        )
        lease = self._build_lease(request, continuation_request, state_fingerprint)
        continuation_request["leaseId"] = lease["leaseId"]
        continuation_request["stateFingerprint"] = state_fingerprint
        self.lease_store.create(lease)
        self._emit_progress(request, "continuation.launch", "started", "Continuation launch requested", lease)

        outcome = continuation.execute_continuation(continuation_request, self.direct_runner, self.gateway_handoff)
        status = _status_from_outcome(outcome)
        lease["status"] = status
        if isinstance(outcome.get("workerPid"), int):
            lease["workerPid"] = outcome["workerPid"]
        if isinstance(outcome.get("error"), str):
            lease["error"] = _truncate(outcome["error"])
        self.lease_store.update(lease)

        if outcome.get("kind") in {"continued", "handoff_requested"}:
            self._emit_progress(request, "continuation.worker", "started", "Continuation worker launched", lease)
        elif outcome.get("kind") == "blocked":
            self._emit_progress(request, "continuation.launch", "blocked", str(outcome.get("detail") or "Continuation blocked"), lease)
        else:
            self._emit_progress(request, "continuation.launch", "failed", str(outcome.get("detail") or "Continuation failed"), lease)

        return _outcome_from_continuation(outcome, lease, workflow_session_id)

    def record_interrupt(self, request: ContinuationInterruptRequest) -> ContinuationControllerOutcome:
        session_id = _string_value(request.get("sessionId")) or "default"
        lease = self.lease_store.read(session_id)
        workflow_session_id = _string_value(request.get("workflowSessionId")) or str((lease or {}).get("workflowSessionId") or session_id)
        if not lease or lease.get("status") not in _ACTIVE_STATUSES:
            return _outcome("skipped", session_id, workflow_session_id, "", "No active continuation lease")
        message = _string_value(request.get("message"))
        if not message:
            return _outcome("blocked", session_id, workflow_session_id, str(lease.get("stateFingerprint") or ""), "Interrupt message missing")
        lease["status"] = "interrupted"
        lease["interruptRequestedAt"] = _now()
        lease["interruptMessage"] = _truncate(message)
        self.lease_store.update(lease)
        self._emit_progress_from_lease(request, "continuation.interrupt", "in-progress", "Continuation interrupt recorded", lease)
        return _outcome(
            "interrupted",
            session_id,
            workflow_session_id,
            str(lease.get("stateFingerprint") or ""),
            "Continuation interrupt recorded",
            lease_id=lease.get("leaseId"),
            strategy=lease.get("strategy"),
        )

    def should_send_gateway_response(
        self,
        session_id: str,
        session_context: JsonObject | dict[str, Any] | None,
        workflow_state: JsonObject | dict[str, Any] | None,
    ) -> ContinuationResponseDecision:
        state = dict(workflow_state or {})
        if continuation.should_send_gateway_response_for_workflow_state(state):
            return {"allow": True, "reason": "truthful stop state"}
        lease = self.lease_store.read(session_id)
        if lease and lease.get("status") in _ACTIVE_STATUSES:
            return {
                "allow": False,
                "reason": "active non-gate continuation",
                "leaseId": str(lease.get("leaseId") or ""),
                "stateFingerprint": str(lease.get("stateFingerprint") or ""),
                "phase": str(state.get("phase") or ""),
                "phaseState": str(state.get("phaseState") or ""),
                "status": lease.get("status") or "running",
            }
        return {"allow": True, "reason": "no active continuation lease"}

    def _build_lease(
        self,
        request: ContinuationControllerRequest,
        continuation_request: continuation.ContinuationRequest,
        state_fingerprint: str,
    ) -> ContinuationLease:
        workflow_state = dict(request.get("workflowState") or {})
        surface = continuation_request.get("surface") or {}
        gateway_routing = continuation_request.get("gatewayRouting")
        now = _now()
        lease: ContinuationLease = {
            "leaseId": uuid4().hex,
            "sessionId": str(continuation_request.get("sessionId") or "default"),
            "workflowSessionId": str(request.get("workflowSessionId") or continuation_request.get("sessionId") or "default"),
            "projectDir": str(request.get("projectDir") or ""),
            "featureName": workflow_state.get("featureName") if isinstance(workflow_state.get("featureName"), str) else None,
            "phase": str(workflow_state.get("phase") or ""),
            "phaseState": str(workflow_state.get("phaseState") or ""),
            "stateFingerprint": state_fingerprint,
            "source": request.get("source") or "post_tool",
            "strategy": continuation.resolve_continuation_strategy(continuation_request),
            "surfaceKind": surface.get("kind") or "unknown",
            "status": "launching",
            "ownerPid": os.getpid(),
            "createdAt": now,
            "updatedAt": now,
            "continuationMessage": str(request.get("message") or ""),
        }
        task_id = workflow_state.get("currentTaskId") or workflow_state.get("taskCompletionInProgress")
        if isinstance(task_id, str) and task_id:
            lease["taskId"] = task_id
        if gateway_routing:
            lease["gatewayRouting"] = gateway_routing
        return lease

    def _emit_progress(
        self,
        request: ContinuationControllerRequest,
        kind: str,
        status: str,
        message: str,
        lease: ContinuationLease,
    ) -> None:
        bridge = request.get("bridge")
        if not bridge:
            return
        try:
            bridge.call(
                "progress.emit",
                {
                    "sessionId": str(lease.get("workflowSessionId") or lease.get("sessionId") or "default"),
                    "kind": kind,
                    "status": status,
                    "message": message,
                    "spanId": f"continuation:{lease.get('leaseId')}",
                    "metadata": {
                        "leaseId": lease.get("leaseId"),
                        "stateFingerprint": lease.get("stateFingerprint"),
                        "workerPid": lease.get("workerPid"),
                        "strategy": lease.get("strategy"),
                    },
                },
            )
        except Exception:
            logger.debug("progress.emit failed for continuation lifecycle", exc_info=True)

    def _emit_progress_from_lease(
        self,
        request: ContinuationInterruptRequest,
        kind: str,
        status: str,
        message: str,
        lease: ContinuationLease,
    ) -> None:
        bridge = request.get("bridge")
        if bridge:
            self._emit_progress({"bridge": bridge}, kind, status, message, lease)


def _status_from_outcome(outcome: ContinuationOutcome) -> ContinuationLeaseStatus:
    kind = outcome.get("kind")
    if kind == "continued":
        return "running"
    if kind == "handoff_requested":
        return "handoff_requested"
    if kind == "blocked":
        return "blocked"
    if kind == "failed":
        return "failed"
    return "blocked"


def _outcome(
    kind: ContinuationControllerOutcomeKind,
    session_id: str,
    workflow_session_id: str,
    state_fingerprint: str,
    detail: str,
    *,
    lease_id: str | None = None,
    strategy: str | None = None,
    worker_pid: int | None = None,
    error: str | None = None,
    suppress_response: bool | None = None,
) -> ContinuationControllerOutcome:
    result: ContinuationControllerOutcome = {
        "kind": kind,
        "sessionId": session_id,
        "workflowSessionId": workflow_session_id,
        "stateFingerprint": state_fingerprint,
        "detail": detail,
    }
    if lease_id:
        result["leaseId"] = lease_id
    if strategy:
        result["strategy"] = strategy  # type: ignore[typeddict-item]
    if worker_pid is not None:
        result["workerPid"] = worker_pid
    if error:
        result["error"] = error
    if suppress_response is not None:
        result["suppressResponse"] = suppress_response
    return result


def _outcome_from_continuation(
    outcome: ContinuationOutcome,
    lease: ContinuationLease,
    workflow_session_id: str,
) -> ContinuationControllerOutcome:
    session_id = str(lease.get("sessionId") or outcome.get("sessionId") or "default")
    kind = outcome.get("kind") or "failed"
    result = _outcome(
        kind if kind in {"continued", "handoff_requested", "blocked", "failed", "skipped"} else "failed",
        session_id,
        workflow_session_id,
        str(lease.get("stateFingerprint") or ""),
        str(outcome.get("detail") or kind),
        lease_id=str(lease.get("leaseId") or ""),
        strategy=outcome.get("strategy"),
        worker_pid=outcome.get("workerPid") if isinstance(outcome.get("workerPid"), int) else None,
        error=outcome.get("error") if isinstance(outcome.get("error"), str) else None,
        suppress_response=kind in {"continued", "handoff_requested"},
    )
    if isinstance(outcome.get("missingFields"), list):
        result["missingFields"] = outcome["missingFields"]
    result["outcome"] = outcome
    return result


def create_continuation_controller(
    *,
    lease_store: ContinuationLeaseStore | None = None,
    direct_runner: DirectContinuationRunner | None = None,
    gateway_handoff: GatewayContinuationHandoff | None = None,
    state_dir: str | None = None,
) -> ContinuationController:
    return DefaultContinuationController(
        lease_store=lease_store or JsonContinuationLeaseStore(state_dir or os.path.join(os.getcwd(), ".openartisan")),
        direct_runner=direct_runner or continuation.NativeSessionDirectContinuationRunner(),
        gateway_handoff=gateway_handoff or continuation.GatewayBackgroundContinuationHandoff(),
    )
