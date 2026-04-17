"""
test_continuation.py — Specification tests for Hermes autonomous continuation.

These tests define the expected behavior for the continuation layer introduced by
hermes-autonomous-continuation. They are intentionally written ahead of the
runtime implementation.
"""

from __future__ import annotations

import pytest

from hermes_adapter.continuation import (
    build_continuation_request,
    classify_continuation_surface,
    execute_continuation,
    resolve_continuation_strategy,
)

from .conftest import MockBridgeClient


class StubDirectRunner:
    def __init__(self, outcome: dict[str, object]) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, object]] = []

    def run(self, request: dict[str, object]) -> dict[str, object]:
        self.calls.append(request)
        return self.outcome


class StubGatewayHandoff:
    def __init__(self, outcome: dict[str, object]) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, object]] = []

    def handoff(self, request: dict[str, object]) -> dict[str, object]:
        self.calls.append(request)
        return self.outcome


class TestContinuationSurfaceClassification:
    def test_classifies_cli_sessions_as_direct_cli(self) -> None:
        surface = classify_continuation_surface(
            {
                "platform": "cli",
                "source": "terminal",
            }
        )

        assert surface == {
            "kind": "direct_cli",
            "platform": "cli",
            "source": "terminal",
        }

    def test_classifies_gateway_platforms_as_gateway_messaging(self) -> None:
        surface = classify_continuation_surface(
            {
                "platform": "telegram",
                "chat_id": "-100123",
                "thread_id": "42",
                "source": "gateway",
            }
        )

        assert surface["kind"] == "gateway_messaging"
        assert surface["platform"] == "telegram"
        assert surface["source"] == "gateway"

    def test_unknown_platforms_remain_unknown(self) -> None:
        surface = classify_continuation_surface(
            {
                "platform": "custom-surface",
            }
        )

        assert surface == {
            "kind": "unknown",
            "platform": "custom-surface",
            "reason": "unrecognized platform",
        }


class TestContinuationRequestConstruction:
    def test_builds_direct_cli_request_from_idle_check_and_session_context(self) -> None:
        request = build_continuation_request(
            session_id="ses-123",
            project_dir="/tmp/project",
            agent="hermes",
            idle_decision={
                "action": "reprompt",
                "message": "Continue with the next ready Open Artisan task.",
            },
            session_context={
                "platform": "cli",
                "source": "terminal",
            },
            workflow_state={"phase": "IMPLEMENTATION", "currentTaskId": "T1"},
        )

        assert request == {
            "sessionId": "ses-123",
            "projectDir": "/tmp/project",
            "agent": "hermes",
            "idleAction": "reprompt",
            "message": "Continue with the next ready Open Artisan task.",
            "surface": {
                "kind": "direct_cli",
                "platform": "cli",
                "source": "terminal",
            },
            "workflowState": {"phase": "IMPLEMENTATION", "currentTaskId": "T1"},
            "rawSessionContext": {
                "platform": "cli",
                "source": "terminal",
            },
        }

    def test_extracts_gateway_routing_metadata_when_present(self) -> None:
        request = build_continuation_request(
            session_id="ses-456",
            project_dir="/tmp/project",
            agent="hermes",
            idle_decision={
                "action": "reprompt",
                "message": "Continue autonomously.",
            },
            session_context={
                "platform": "telegram",
                "source": "gateway",
                "chat_id": "-100500",
                "thread_id": "77",
                "user_id": "1234",
                "message_id": "999",
                "session_origin": "telegram:-100500:77",
            },
            workflow_state={"phase": "IMPLEMENTATION", "currentTaskId": "T2"},
        )

        assert request["surface"]["kind"] == "gateway_messaging"
        assert request["gatewayRouting"] == {
            "platform": "telegram",
            "chatId": "-100500",
            "threadId": "77",
            "userId": "1234",
            "messageId": "999",
            "sessionOrigin": "telegram:-100500:77",
        }


class TestContinuationStrategyResolution:
    def test_direct_cli_request_uses_direct_runner_strategy(self) -> None:
        strategy = resolve_continuation_strategy(
            {
                "sessionId": "ses-1",
                "surface": {"kind": "direct_cli", "platform": "cli"},
            }
        )

        assert strategy == "direct_runner"

    def test_gateway_request_uses_gateway_handoff_strategy(self) -> None:
        strategy = resolve_continuation_strategy(
            {
                "sessionId": "ses-2",
                "surface": {"kind": "gateway_messaging", "platform": "telegram"},
                "gatewayRouting": {
                    "platform": "telegram",
                    "chatId": "-100500",
                    "threadId": "77",
                    "userId": "1234",
                    "messageId": "999",
                    "sessionOrigin": "telegram:-100500:77",
                },
            }
        )

        assert strategy == "gateway_handoff"

    def test_gateway_request_without_routing_metadata_does_not_fake_handoff(self) -> None:
        strategy = resolve_continuation_strategy(
            {
                "sessionId": "ses-3",
                "surface": {"kind": "gateway_messaging", "platform": "telegram"},
            }
        )

        assert strategy == "none"


class TestContinuationExecution:
    def test_execute_continuation_dispatches_direct_runner(self) -> None:
        request = {
            "sessionId": "ses-4",
            "surface": {"kind": "direct_cli", "platform": "cli"},
            "message": "Continue with the next task.",
        }
        direct_runner = StubDirectRunner(
            {
                "kind": "continued",
                "strategy": "direct_runner",
                "sessionId": "ses-4",
                "detail": "continued in-process",
            }
        )
        gateway_handoff = StubGatewayHandoff(
            {
                "kind": "handoff_requested",
                "strategy": "gateway_handoff",
                "sessionId": "ses-4",
                "detail": "queued for gateway delivery",
            }
        )

        outcome = execute_continuation(request, direct_runner, gateway_handoff)

        assert outcome["kind"] == "continued"
        assert direct_runner.calls == [request]
        assert gateway_handoff.calls == []

    def test_execute_continuation_dispatches_gateway_handoff(self) -> None:
        request = {
            "sessionId": "ses-5",
            "surface": {"kind": "gateway_messaging", "platform": "telegram"},
            "gatewayRouting": {
                "platform": "telegram",
                "chatId": "-100500",
                "threadId": "77",
                "userId": "1234",
                "messageId": "999",
                "sessionOrigin": "telegram:-100500:77",
            },
            "message": "Continue with the next task.",
        }
        direct_runner = StubDirectRunner(
            {
                "kind": "continued",
                "strategy": "direct_runner",
                "sessionId": "ses-5",
                "detail": "continued in-process",
            }
        )
        gateway_handoff = StubGatewayHandoff(
            {
                "kind": "handoff_requested",
                "strategy": "gateway_handoff",
                "sessionId": "ses-5",
                "detail": "queued for gateway delivery",
            }
        )

        outcome = execute_continuation(request, direct_runner, gateway_handoff)

        assert outcome["kind"] == "handoff_requested"
        assert direct_runner.calls == []
        assert gateway_handoff.calls == [request]

    def test_execute_continuation_reports_missing_gateway_fields_truthfully(self) -> None:
        request = {
            "sessionId": "ses-6",
            "surface": {"kind": "gateway_messaging", "platform": "telegram"},
            "message": "Continue with the next task.",
        }
        direct_runner = StubDirectRunner(
            {
                "kind": "continued",
                "strategy": "direct_runner",
                "sessionId": "ses-6",
                "detail": "continued in-process",
            }
        )
        gateway_handoff = StubGatewayHandoff(
            {
                "kind": "handoff_requested",
                "strategy": "gateway_handoff",
                "sessionId": "ses-6",
                "detail": "queued for gateway delivery",
            }
        )

        outcome = execute_continuation(request, direct_runner, gateway_handoff)

        assert outcome == {
            "kind": "blocked",
            "strategy": "none",
            "sessionId": "ses-6",
            "detail": "missing gateway routing metadata",
            "missingFields": [
                "chatId",
                "messageId",
                "platform",
                "sessionOrigin",
                "threadId",
                "userId",
            ],
        }
        assert direct_runner.calls == []
        assert gateway_handoff.calls == []


class TestAdapterLifecycleIntegrationContract:
    def test_idle_check_reprompt_for_cli_turn_is_executable(self) -> None:
        bridge = MockBridgeClient()
        bridge.set_response(
            "idle.check",
            {
                "action": "reprompt",
                "message": "Continue with the next ready Open Artisan task.",
            },
        )

        idle_decision = bridge.call("idle.check", {"sessionId": "ses-7"})
        request = build_continuation_request(
            session_id="ses-7",
            project_dir="/tmp/project",
            agent="hermes",
            idle_decision=idle_decision,
            session_context={"platform": "cli", "source": "terminal"},
            workflow_state={"phase": "IMPLEMENTATION", "currentTaskId": "T7"},
        )

        assert resolve_continuation_strategy(request) == "direct_runner"

    @pytest.mark.parametrize(
        ("idle_action", "message"),
        [
            ("ignore", "workflow at USER_GATE"),
            ("escalate", "workflow stalled"),
        ],
    )
    def test_non_reprompt_idle_actions_do_not_create_executable_continuation_requests(
        self, idle_action: str, message: str
    ) -> None:
        with pytest.raises(ValueError, match="reprompt"):
            build_continuation_request(
                session_id="ses-8",
                project_dir="/tmp/project",
                agent="hermes",
                idle_decision={"action": idle_action, "message": message},
                session_context={"platform": "cli", "source": "terminal"},
                workflow_state={"phase": "USER_GATE"},
            )
