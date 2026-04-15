"""
test_shared_bridge.py — Interface-first contract tests for Hermes shared-bridge
behavior.

These tests import only approved adapter interfaces and should fail until the
runtime wiring exists.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from hermes_adapter.bridge_client import StdioBridgeClient
from hermes_adapter.constants import (
    BRIDGE_LEASES_FILENAME,
    BRIDGE_METADATA_FILENAME,
    DEFAULT_SOCKET_FILENAME,
)
from hermes_adapter.types import (
    AttachBridgeParams,
    AttachBridgeResult,
    BridgeClient,
    BridgeDiscoveryResult,
    BridgeShutdownEligibility,
    DetachBridgeParams,
)


def make_bridge_client() -> BridgeClient:
    return StdioBridgeClient()


def _write_bridge_state(
    tmp_path: Path,
    *,
    protocol_version: str = "1",
    pid: int | None = None,
    clients: list[dict] | None = None,
    malformed_metadata: bool = False,
) -> None:
    state_dir = tmp_path / ".openartisan"
    state_dir.mkdir(parents=True, exist_ok=True)

    if malformed_metadata:
        (state_dir / BRIDGE_METADATA_FILENAME).write_text("{not-json")
        return

    metadata = {
        "version": 1,
        "bridgeInstanceId": "bridge-1",
        "projectDir": str(tmp_path),
        "stateDir": str(state_dir),
        "transport": "unix-socket",
        "socketPath": str(state_dir / DEFAULT_SOCKET_FILENAME),
        "protocolVersion": protocol_version,
        "startedAt": "2026-04-14T12:00:00Z",
        "lastHeartbeatAt": "2026-04-14T12:01:00Z",
        "adapterCompatibility": {"claudeCode": True, "hermes": True},
    }
    (state_dir / BRIDGE_METADATA_FILENAME).write_text(json.dumps(metadata))
    (state_dir / BRIDGE_LEASES_FILENAME).write_text(
        json.dumps({"bridgeInstanceId": "bridge-1", "clients": clients or []})
    )
    if pid is not None:
        (state_dir / ".bridge-pid").write_text(f"{pid}\n")
    (state_dir / DEFAULT_SOCKET_FILENAME).write_text("")


class TestSharedBridgeDiscovery:
    """Hermes should classify local bridge state through the adapter contract."""

    def test_discover_bridge_returns_no_bridge_when_state_dir_is_empty(self, tmp_path):
        bridge = make_bridge_client()

        result: BridgeDiscoveryResult = bridge.discover_bridge(
            str(tmp_path), str(tmp_path / ".openartisan")
        )

        assert result["kind"] == "no_bridge"

    def test_discover_bridge_returns_live_compatible_bridge_when_metadata_is_reusable(
        self, tmp_path
    ):
        _write_bridge_state(
            tmp_path,
            pid=os.getpid(),
            clients=[{"clientId": "claude-1", "clientKind": "claude-code"}],
        )
        bridge = make_bridge_client()

        result: BridgeDiscoveryResult = bridge.discover_bridge(
            str(tmp_path), str(tmp_path / ".openartisan")
        )

        assert result["kind"] == "live_compatible_bridge"
        assert "metadata" in result

    def test_discover_bridge_returns_stale_bridge_state_for_dead_pid_and_socket(
        self, tmp_path
    ):
        _write_bridge_state(tmp_path, pid=999999)
        bridge = make_bridge_client()

        result: BridgeDiscoveryResult = bridge.discover_bridge(
            str(tmp_path), str(tmp_path / ".openartisan")
        )

        assert result["kind"] == "stale_bridge_state"
        assert result["stalePaths"]

    def test_discover_bridge_surfaces_invalid_metadata_as_attach_failed(self, tmp_path):
        _write_bridge_state(tmp_path, malformed_metadata=True)
        bridge = make_bridge_client()

        result: BridgeDiscoveryResult = bridge.discover_bridge(
            str(tmp_path), str(tmp_path / ".openartisan")
        )

        assert result["kind"] == "attach_failed"


class TestSharedBridgeAttachOrStart:
    """Hermes should attach safely to shared local bridges."""

    def test_attach_or_start_attaches_to_existing_bridge(self, tmp_path):
        _write_bridge_state(
            tmp_path,
            pid=os.getpid(),
            clients=[{"clientId": "claude-1", "clientKind": "claude-code"}],
        )
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
        _write_bridge_state(tmp_path, protocol_version="999", pid=os.getpid())
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

    def test_detach_client_does_not_allow_shutdown_while_other_clients_remain(
        self, tmp_path
    ):
        _write_bridge_state(
            tmp_path,
            clients=[
                {"clientId": "hermes-a", "clientKind": "hermes"},
                {"clientId": "claude-1", "clientKind": "claude-code"},
            ],
        )
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

        with pytest.raises(Exception, match="Bridge subprocess is not running"):
            bridge.call("bridge.discover", {"projectDir": str(tmp_path)})

    def test_start_then_shutdown_is_a_supported_lifecycle(self, tmp_path):
        bridge = make_bridge_client()

        bridge.start(str(tmp_path))
        bridge.shutdown()

        assert bridge.is_alive is False
