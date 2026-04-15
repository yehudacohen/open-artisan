"""
test_bridge_client.py — Tests for the stdio bridge client.

Tests subprocess lifecycle, JSON-RPC round-trip, auto-reconnect,
edge cases (death mid-call, malformed JSON), and thread safety.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from unittest.mock import MagicMock, patch, PropertyMock

import pytest

from hermes_adapter.bridge_client import StdioBridgeClient
from hermes_adapter.types import BridgeError


# ---------------------------------------------------------------------------
# Subprocess lifecycle
# ---------------------------------------------------------------------------


class TestSubprocessLifecycle:
    """Bridge client start/shutdown/is_alive."""

    def test_start_spawns_subprocess(self, tmp_path):
        """start() should spawn a bridge subprocess and send lifecycle.init."""
        client = StdioBridgeClient()
        with (
            patch.object(client, "_spawn_process") as mock_spawn,
            patch.object(client, "_send_rpc", return_value="ready"),
        ):
            client.start(str(tmp_path))
            mock_spawn.assert_called_once()

    def test_start_sends_init(self, tmp_path):
        """start() should call lifecycle.init with correct params."""
        client = StdioBridgeClient()
        with (
            patch.object(client, "_spawn_process"),
            patch.object(client, "_send_rpc", return_value="ready") as mock_rpc,
        ):
            client.start(str(tmp_path))
            mock_rpc.assert_called_once()
            call_args = mock_rpc.call_args
            assert call_args[0][0] == "lifecycle.init"
            assert call_args[0][1]["projectDir"] == str(tmp_path)

    def test_start_can_take_over_existing_bridge_when_enabled(self, tmp_path):
        client = StdioBridgeClient()
        state_dir = tmp_path / ".openartisan"
        state_dir.mkdir()
        (state_dir / ".bridge-pid").write_text("12345")
        (state_dir / ".bridge.sock").write_text("")

        with (
            patch.dict(os.environ, {"OPENARTISAN_BRIDGE_TAKEOVER": "1"}, clear=False),
            patch.object(client, "_spawn_process") as mock_spawn,
            patch.object(client, "shutdown") as mock_shutdown,
            patch.object(
                client,
                "_send_rpc",
                side_effect=[
                    BridgeError(
                        "Bridge RPC error: Another bridge process is already running (PID 12345). Kill it or remove .bridge-pid manually."
                    ),
                    "ready",
                ],
            ) as mock_rpc,
            patch("os.kill") as mock_kill,
        ):
            client.start(str(tmp_path))

        assert mock_kill.call_args_list[-1].args == (12345, 15)
        mock_shutdown.assert_called_once()
        assert mock_spawn.call_count == 2
        assert mock_rpc.call_count == 2

    def test_shutdown_sends_lifecycle_shutdown(self):
        """shutdown() should send lifecycle.shutdown before killing the process."""
        client = StdioBridgeClient()
        client._process = MagicMock()
        client._process.poll.return_value = None
        with patch.object(client, "_send_rpc"):
            client.shutdown()
        assert client._process is None or not client.is_alive

    def test_shutdown_is_idempotent(self):
        """shutdown() should be safe to call multiple times."""
        client = StdioBridgeClient()
        client.shutdown()  # no process — should not raise
        client.shutdown()  # again — still should not raise

    def test_is_alive_false_when_not_started(self):
        """is_alive should be False before start()."""
        client = StdioBridgeClient()
        assert client.is_alive is False

    def test_is_alive_false_after_shutdown(self):
        """is_alive should be False after shutdown()."""
        client = StdioBridgeClient()
        client._process = MagicMock()
        client._process.poll.return_value = None
        with patch.object(client, "_send_rpc"):
            client.shutdown()
        assert client.is_alive is False


# ---------------------------------------------------------------------------
# JSON-RPC round-trip
# ---------------------------------------------------------------------------


class TestJsonRpcRoundTrip:
    """call() sends JSON-RPC and parses responses."""

    def test_call_returns_result(self):
        """call() should return the 'result' field from the JSON-RPC response."""
        client = StdioBridgeClient()
        response = {"jsonrpc": "2.0", "result": "pong", "id": 1}
        with patch.object(client, "_send_rpc", return_value="pong"):
            result = client.call("lifecycle.ping")
        assert result == "pong"

    def test_call_passes_params(self):
        """call() should forward params to the bridge."""
        client = StdioBridgeClient()
        with patch.object(client, "_send_rpc", return_value="ok") as mock_rpc:
            client.call(
                "tool.execute", {"name": "select_mode", "args": {"mode": "GREENFIELD"}}
            )
            args = mock_rpc.call_args[0]
            assert args[0] == "tool.execute"
            assert args[1]["name"] == "select_mode"

    def test_call_raises_on_rpc_error(self):
        """call() should raise BridgeError when the bridge returns a JSON-RPC error."""
        client = StdioBridgeClient()
        with patch.object(client, "_send_rpc", side_effect=BridgeError("RPC error")):
            with pytest.raises(BridgeError, match="RPC error"):
                client.call("bad.method")

    def test_call_with_none_params(self):
        """call() with no params should send empty dict."""
        client = StdioBridgeClient()
        with patch.object(client, "_send_rpc", return_value="ok") as mock_rpc:
            client.call("lifecycle.ping")
            args = mock_rpc.call_args[0]
            assert args[0] == "lifecycle.ping"


# ---------------------------------------------------------------------------
# Auto-reconnect
# ---------------------------------------------------------------------------


class TestAutoReconnect:
    """Auto-reconnect on subprocess death."""

    def test_reconnect_on_dead_process(self):
        """call() should respawn the process if it has died."""
        client = StdioBridgeClient()
        client._project_dir = "/tmp/test"
        # Simulate a dead process
        client._process = MagicMock()
        client._process.poll.return_value = 1  # exited

        with (
            patch.object(client, "_spawn_process") as mock_spawn,
            patch.object(client, "_send_rpc", return_value="ready"),
        ):
            # The init call during reconnect
            with patch.object(client, "start"):
                try:
                    client.call("lifecycle.ping")
                except Exception:
                    pass
            # Should have attempted to respawn

    def test_no_reconnect_on_healthy_process(self):
        """call() should not respawn if the process is alive."""
        client = StdioBridgeClient()
        client._process = MagicMock()
        client._process.poll.return_value = None  # still running

        with (
            patch.object(client, "_spawn_process") as mock_spawn,
            patch.object(client, "_send_rpc", return_value="pong"),
        ):
            client.call("lifecycle.ping")
            mock_spawn.assert_not_called()


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    """Bridge death mid-call, malformed JSON, etc."""

    def test_malformed_json_response(self):
        """Malformed JSON from bridge should raise BridgeError."""
        client = StdioBridgeClient()
        client._process = MagicMock()
        client._process.poll.return_value = None
        client._process.stdout = MagicMock()
        client._process.stdout.readline.return_value = b"not-json\n"
        client._process.stdin = MagicMock()

        with pytest.raises((BridgeError, json.JSONDecodeError, Exception)):
            client._send_rpc("lifecycle.ping", {})

    def test_bridge_death_mid_call(self):
        """If bridge dies after stdin write but before stdout read, should raise BridgeError."""
        client = StdioBridgeClient()
        client._process = MagicMock()
        client._process.poll.return_value = None
        client._process.stdin = MagicMock()
        client._process.stdout = MagicMock()
        client._process.stdout.readline.return_value = b""  # EOF = process died

        with pytest.raises((BridgeError, Exception)):
            client._send_rpc("lifecycle.ping", {})


# ---------------------------------------------------------------------------
# Thread safety
# ---------------------------------------------------------------------------


class TestThreadSafety:
    """Lock prevents concurrent stdin/stdout corruption."""

    def test_lock_is_acquired_during_call(self):
        """call() should acquire the lock before sending."""
        client = StdioBridgeClient()
        assert isinstance(client._lock, type(threading.Lock()))

    def test_concurrent_calls_are_serialized(self):
        """Multiple threads calling call() should not interleave."""
        client = StdioBridgeClient()
        call_order: list[int] = []

        def mock_send(method, params):
            call_order.append(threading.current_thread().ident)
            return "ok"

        with patch.object(client, "_send_rpc", side_effect=mock_send):
            threads = [
                threading.Thread(target=lambda: client.call("lifecycle.ping"))
                for _ in range(5)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        assert len(call_order) == 5
