from __future__ import annotations

from pathlib import Path
from typing import Any

from hermes_adapter.continuation_controller import (
    JsonContinuationLeaseStore,
    create_continuation_controller,
)

from .conftest import MockBridgeClient


class StubDirectRunner:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def run(self, request: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(request)
        return {
            "kind": "continued",
            "strategy": "direct_runner",
            "sessionId": request["sessionId"],
            "detail": "direct worker launched",
            "workerPid": 12345,
        }


class StubGatewayHandoff:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def handoff(self, request: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(request)
        return {
            "kind": "handoff_requested",
            "strategy": "gateway_handoff",
            "sessionId": request["sessionId"],
            "detail": "gateway worker launched",
            "workerPid": 23456,
        }


def _request(tmp_path: Path, **overrides: Any) -> dict[str, Any]:
    request = {
        "bridge": MockBridgeClient(),
        "authorSessionId": "hermes-session",
        "workflowSessionId": "workflow-session",
        "projectDir": str(tmp_path),
        "agent": "hermes",
        "source": "post_tool",
        "message": "Continue authoring INTERFACES/DRAFT.",
        "sessionContext": {"platform": "cli", "source": "terminal"},
        "workflowState": {
            "featureName": "controller-feature",
            "phase": "INTERFACES",
            "phaseState": "DRAFT",
            "currentTaskId": None,
        },
    }
    request.update(overrides)
    return request


def test_controller_suppresses_duplicate_continuation_for_same_state(tmp_path: Path) -> None:
    bridge = MockBridgeClient()
    direct = StubDirectRunner()
    controller = create_continuation_controller(
        lease_store=JsonContinuationLeaseStore(str(tmp_path / ".openartisan")),
        direct_runner=direct,
        gateway_handoff=StubGatewayHandoff(),
    )
    request = _request(tmp_path, bridge=bridge)

    first = controller.continue_authoring(request)
    second = controller.continue_authoring({**request, "source": "session_end_idle"})

    assert first["kind"] == "continued"
    assert first["workerPid"] == 12345
    assert second["kind"] == "duplicate_suppressed"
    assert second["leaseId"] == first["leaseId"]
    assert direct.calls == [direct.calls[0]]
    progress_messages = [params["message"] for _, params in bridge.get_calls("progress.emit")]
    assert any("Continuation worker launched" in message for message in progress_messages)
    assert any("Duplicate continuation suppressed" in message for message in progress_messages)


def test_gateway_response_decision_blocks_non_gate_active_continuation(tmp_path: Path) -> None:
    gateway = StubGatewayHandoff()
    controller = create_continuation_controller(
        lease_store=JsonContinuationLeaseStore(str(tmp_path / ".openartisan")),
        direct_runner=StubDirectRunner(),
        gateway_handoff=gateway,
    )
    request = _request(
        tmp_path,
        sessionContext={
            "platform": "discord",
            "source": "gateway",
            "chat_id": "chat-1",
            "thread_id": "thread-1",
            "session_origin": "agent:main:discord:thread:chat-1:thread-1",
        },
    )

    outcome = controller.continue_authoring(request)
    blocked = controller.should_send_gateway_response(
        "hermes-session",
        request["sessionContext"],
        {"phase": "IMPL_PLAN", "phaseState": "DRAFT"},
    )
    allowed = controller.should_send_gateway_response(
        "hermes-session",
        request["sessionContext"],
        {"phase": "IMPL_PLAN", "phaseState": "USER_GATE"},
    )

    assert outcome["kind"] == "handoff_requested"
    assert len(gateway.calls) == 1
    assert blocked["allow"] is False
    assert blocked["reason"] == "active non-gate continuation"
    assert allowed["allow"] is True


def test_non_gate_interrupt_updates_lease_without_message_process(tmp_path: Path) -> None:
    bridge = MockBridgeClient()
    controller = create_continuation_controller(
        lease_store=JsonContinuationLeaseStore(str(tmp_path / ".openartisan")),
        direct_runner=StubDirectRunner(),
        gateway_handoff=StubGatewayHandoff(),
    )
    request = _request(tmp_path, bridge=bridge)
    launched = controller.continue_authoring(request)

    interrupted = controller.record_interrupt(
        {
            "sessionId": "hermes-session",
            "workflowSessionId": "workflow-session",
            "projectDir": str(tmp_path),
            "message": "Actually focus on the Discord interrupt path first.",
            "sessionContext": request["sessionContext"],
        }
    )

    assert launched["kind"] == "continued"
    assert interrupted["kind"] == "interrupted"
    assert interrupted["leaseId"] == launched["leaseId"]
    assert bridge.get_calls("message.process") == []
