"""
test_shared_bridge.py — Interface-first contract tests for Hermes shared-bridge
behavior.

These tests import only approved adapter interfaces and should fail until the
runtime wiring exists.
"""

from __future__ import annotations

import pytest

from hermes_adapter.types import (
    AttachBridgeParams,
    AttachBridgeResult,
    BridgeClient,
    BridgeDiscoveryResult,
    BridgeShutdownEligibility,
    DetachBridgeParams,
)


def make_bridge_client() -> BridgeClient:
    raise NotImplementedError("Hermes shared-bridge contract not implemented")


class TestSharedBridgeDiscovery:
    """Hermes should classify local bridge state through the adapter contract."""

    def test_discover_bridge_returns_no_bridge_when_state_dir_is_empty(self, tmp_path):
        bridge = make_bridge_client()

        result: BridgeDiscoveryResult = bridge.discover_bridge(
            str(tmp_path), str(tmp_path / ".openartisan")
        )

        assert result["kind"] == "no_bridge"

    def test_discover_bridge_returns_live_compatible_bridge_when_metadata_is_reusable(self, tmp_path):
        bridge = make_bridge_client()

        result: BridgeDiscoveryResult = bridge.discover_bridge(
            str(tmp_path), str(tmp_path / ".openartisan")
        )

        assert result["kind"] == "live_compatible_bridge"
        assert "metadata" in result

    def test_discover_bridge_returns_stale_bridge_state_for_dead_pid_and_socket(self, tmp_path):
        bridge = make_bridge_client()

        result: BridgeDiscoveryResult = bridge.discover_bridge(
            str(tmp_path), str(tmp_path / ".openartisan")
        )

        assert result["kind"] == "stale_bridge_state"
        assert result["stalePaths"]

    def test_discover_bridge_surfaces_invalid_metadata_as_attach_failed(self, tmp_path):
        bridge = make_bridge_client()

        result: BridgeDiscoveryResult = bridge.discover_bridge(
            str(tmp_path), str(tmp_path / ".openartisan")
        )

        assert result["kind"] == "attach_failed"


class TestSharedBridgeAttachOrStart:
    """Hermes should attach safely to shared local bridges."""

    def test_attach_or_start_attaches_to_existing_bridge(self, tmp_path):
        bridge = make_bridge_client()
        params: AttachBridgeParams = {
            "projectDir": str(tmp_path),
            "stateDir": str(tmp_path / ".openartisan"),
            "clientId": "hermes-a",
            "clientKind": "hermes",
            "sessionId": "session-a",
        }

        result: AttachBridgeResult = bridge.attach_or_start(params)

        assert result["kind"] == "attached_existing"
        assert result["lease"]["clientId"] == "hermes-a"

    def test_attach_or_start_starts_new_bridge_when_none_exists(self, tmp_path):
        bridge = make_bridge_client()

        result: AttachBridgeResult = bridge.attach_or_start(
            {
                "projectDir": str(tmp_path),
                "stateDir": str(tmp_path / ".openartisan"),
                "clientId": "hermes-b",
                "clientKind": "hermes",
                "sessionId": "session-b",
            }
        )

        assert result["kind"] == "started_new_and_attached"

    def test_attach_or_start_rejects_incompatible_live_bridge(self, tmp_path):
        bridge = make_bridge_client()

        result: AttachBridgeResult = bridge.attach_or_start(
            {
                "projectDir": str(tmp_path),
                "stateDir": str(tmp_path / ".openartisan"),
                "clientId": "hermes-c",
                "clientKind": "hermes",
                "sessionId": "session-c",
            }
        )

        assert result["kind"] == "rejected_incompatible_bridge"

    def test_attach_or_start_returns_failed_attach_on_transport_timeout(self, tmp_path):
        bridge = make_bridge_client()

        result: AttachBridgeResult = bridge.attach_or_start(
            {
                "projectDir": str(tmp_path),
                "stateDir": str(tmp_path / ".openartisan"),
                "clientId": "hermes-timeout",
                "clientKind": "hermes",
                "sessionId": "timeout-session",
                "capabilities": {"supportsReconnect": True},
            }
        )

        assert result["kind"] == "failed_attach"

    def test_attach_or_start_rejects_missing_required_client_id(self, tmp_path):
        bridge = make_bridge_client()

        with pytest.raises((KeyError, ValueError), match="clientId"):
            bridge.attach_or_start(
                {
                    "projectDir": str(tmp_path),
                    "stateDir": str(tmp_path / ".openartisan"),
                    "clientKind": "hermes",
                }
            )


class TestSharedBridgeDetach:
    """Hermes detach should respect multi-client ownership and shutdown safety."""

    def test_detach_client_does_not_allow_shutdown_while_other_clients_remain(self, tmp_path):
        bridge = make_bridge_client()
        params: DetachBridgeParams = {
            "projectDir": str(tmp_path),
            "stateDir": str(tmp_path / ".openartisan"),
            "clientId": "hermes-a",
            "reason": "disconnect",
        }

        result: BridgeShutdownEligibility = bridge.detach_client(params)

        assert result["allowed"] is False
        assert result["blockingClientIds"]

    def test_detach_client_allows_shutdown_for_last_client(self, tmp_path):
        bridge = make_bridge_client()

        result: BridgeShutdownEligibility = bridge.detach_client(
            {
                "projectDir": str(tmp_path),
                "stateDir": str(tmp_path / ".openartisan"),
                "clientId": "hermes-last",
                "reason": "shutdown",
            }
        )

        assert result["activeClientCount"] == 0

    def test_detach_client_rejects_invalid_reason_values(self, tmp_path):
        bridge = make_bridge_client()

        with pytest.raises((KeyError, ValueError), match="reason"):
            bridge.detach_client(
                {
                    "projectDir": str(tmp_path),
                    "stateDir": str(tmp_path / ".openartisan"),
                    "clientId": "hermes-invalid",
                    "reason": "boom",
                }
            )


class TestBridgeClientOperationalBehavior:
    """Operational degradation and lifecycle expectations for BridgeClient."""

    def test_call_raises_when_transport_breaks(self, tmp_path):
        bridge = make_bridge_client()

        with pytest.raises(Exception, match="transport"):
            bridge.call("bridge.discover", {"projectDir": str(tmp_path)})

    def test_start_then_shutdown_is_a_supported_lifecycle(self, tmp_path):
        bridge = make_bridge_client()

        bridge.start(str(tmp_path))
        bridge.shutdown()

        assert bridge.is_alive is False
