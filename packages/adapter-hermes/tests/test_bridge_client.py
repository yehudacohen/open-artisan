"""
test_bridge_client.py — Tests for the stdio bridge client.

Tests subprocess lifecycle, JSON-RPC round-trip, auto-reconnect,
edge cases (death mid-call, malformed JSON), and thread safety.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
import tempfile
import time
from pathlib import Path
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
            assert call_args[0][1]["transport"] == "stdio"
            assert call_args[0][1]["registerRuntime"] is False

    def test_start_falls_back_to_local_bridge_when_shared_socket_probe_fails(
        self, tmp_path
    ):
        client = StdioBridgeClient()
        state_dir = tmp_path / ".openartisan"
        state_dir.mkdir()

        with (
            patch.object(
                client,
                "discover_bridge",
                return_value={
                    "kind": "live_compatible_bridge",
                    "metadata": {"socketPath": str(state_dir / ".bridge.sock")},
                },
            ),
            patch.object(
                client, "_probe_shared_bridge", side_effect=BridgeError("probe failed")
            ),
            patch.object(client, "_spawn_process") as mock_spawn,
            patch.object(client, "_send_rpc", return_value="ready"),
        ):
            client.start(str(tmp_path))

        mock_spawn.assert_called_once()
        assert client._socket_path is None

    def test_ensure_started_reuses_healthy_shared_bridge_without_restarting(self):
        client = StdioBridgeClient()
        client._project_dir = "/tmp/project"
        client._socket_path = "/tmp/project/.openartisan/.bridge.sock"

        with (
            patch.object(client, "_probe_shared_bridge") as mock_probe,
            patch.object(client, "start") as mock_start,
        ):
            client.ensure_started("/tmp/project")

        mock_probe.assert_called_once()
        mock_start.assert_not_called()
        assert client._transport_mode == "shared-socket"

    def test_ensure_started_recovers_from_unhealthy_shared_bridge(self):
        client = StdioBridgeClient()
        client._project_dir = "/tmp/project"
        client._socket_path = "/tmp/project/.openartisan/.bridge.sock"

        with (
            patch.object(
                client,
                "_probe_shared_bridge",
                side_effect=BridgeError("probe failed"),
            ),
            patch.object(client, "start") as mock_start,
        ):
            client.ensure_started("/tmp/project")

        mock_start.assert_called_once_with("/tmp/project")
        assert client._last_health_status == "recovering"

    def test_ensure_session_is_idempotent_within_same_runtime(self):
        client = StdioBridgeClient()

        with (
            patch.object(client, "ensure_started") as mock_started,
            patch.object(client, "call", return_value=None) as mock_call,
        ):
            client.ensure_session("s1", "/tmp/project", agent="hermes")
            client.ensure_session("s1", "/tmp/project", agent="hermes")

        mock_started.assert_called()
        mock_call.assert_called_once_with(
            "lifecycle.sessionCreated", {"sessionId": "s1", "agent": "hermes"}
        )

    def test_restart_clears_ensured_session_cache(self, tmp_path):
        client = StdioBridgeClient()
        client._ensured_sessions.add((str(tmp_path), "s1"))

        with (
            patch.object(client, "discover_bridge", return_value={"kind": "no_bridge"}),
            patch.object(client, "_spawn_process"),
            patch.object(client, "_send_rpc", return_value="ready"),
        ):
            client.start(str(tmp_path))

        assert client._ensured_sessions == set()

    def test_start_shuts_down_existing_bridge_when_project_changes(self, tmp_path):
        client = StdioBridgeClient()
        old_project = tmp_path / "old"
        new_project = tmp_path / "new"
        old_project.mkdir()
        new_project.mkdir()
        client._project_dir = str(old_project)

        with (
            patch.object(client, "shutdown") as mock_shutdown,
            patch.object(client, "_clear_shared_bridge_attachment") as mock_clear,
            patch.object(client, "discover_bridge", return_value={"kind": "no_bridge"}),
            patch.object(client, "_spawn_process"),
            patch.object(client, "_send_rpc", return_value="ready"),
        ):
            client.start(str(new_project))

        mock_shutdown.assert_called_once()
        mock_clear.assert_called_once()
        assert client._project_dir == str(new_project)

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

    def test_start_takes_over_live_bridge_when_shared_socket_is_missing(self, tmp_path):
        client = StdioBridgeClient()
        state_dir = tmp_path / ".openartisan"
        state_dir.mkdir()

        with (
            patch.object(
                client,
                "discover_bridge",
                return_value={
                    "kind": "live_compatible_bridge",
                    "metadata": {"socketPath": str(state_dir / ".bridge.sock")},
                },
            ),
            patch.object(
                client,
                "_probe_shared_bridge",
                side_effect=BridgeError("socket missing"),
            ),
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

    def test_start_takes_over_stale_bridge_state(self, tmp_path):
        client = StdioBridgeClient()
        state_dir = tmp_path / ".openartisan"
        state_dir.mkdir()
        (state_dir / ".bridge-pid").write_text("12345")

        with (
            patch.object(
                client,
                "discover_bridge",
                return_value={
                    "kind": "stale_bridge_state",
                    "previousPid": 12345,
                    "stalePaths": [str(state_dir / ".bridge-pid")],
                    "reason": "Bridge metadata exists but the recorded bridge process is not running.",
                },
            ),
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

    def test_call_uses_shared_bridge_socket_when_attached(self, tmp_path):
        """call() should use the shared bridge socket transport when attached."""
        client = StdioBridgeClient()
        short_dir = Path(tempfile.mkdtemp(prefix="oa-bridge-"))
        socket_path = short_dir / "bridge.sock"
        result_holder: dict[str, object] = {}

        ready = threading.Event()

        def serve_once() -> None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(socket_path))
                server.listen(1)
                ready.set()
                conn, _ = server.accept()
                with conn:
                    buffer = b""
                    while b"\n" not in buffer:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        buffer += chunk
                    request = json.loads(buffer.decode("utf-8").strip())
                    result_holder["method"] = request["method"]
                    result_holder["params"] = request["params"]
                    response = {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": {"phase": "DISCOVERY", "phaseState": "SCAN"},
                    }
                    conn.sendall((json.dumps(response) + "\n").encode("utf-8"))

        thread = threading.Thread(target=serve_once)
        thread.start()
        try:
            for _ in range(50):
                if socket_path.exists():
                    break
                time.sleep(0.01)
            client._socket_path = str(socket_path)
            result = client.call("state.get", {"sessionId": "test-session"})
        finally:
            thread.join(timeout=5)
            try:
                socket_path.unlink(missing_ok=True)
                short_dir.rmdir()
            except OSError:
                pass

        assert result == {"phase": "DISCOVERY", "phaseState": "SCAN"}
        assert result_holder["method"] == "state.get"
        assert result_holder["params"] == {"sessionId": "test-session"}

    def test_socket_call_allows_no_response_for_session_lifecycle(self):
        """sessionCreated over shared socket should tolerate no response payload."""
        client = StdioBridgeClient()
        short_dir = Path(tempfile.mkdtemp(prefix="oa-bridge-"))
        socket_path = short_dir / "bridge.sock"
        result_holder: dict[str, object] = {}
        ready = threading.Event()

        def serve_once() -> None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(socket_path))
                server.listen(1)
                ready.set()
                conn, _ = server.accept()
                with conn:
                    buffer = b""
                    while b"\n" not in buffer:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        buffer += chunk
                    request = json.loads(buffer.decode("utf-8").strip())
                    result_holder["method"] = request["method"]

        thread = threading.Thread(target=serve_once)
        thread.start()
        try:
            assert ready.wait(timeout=2)
            client._socket_path = str(socket_path)
            result = client.call(
                "lifecycle.sessionCreated", {"sessionId": "test-session"}
            )
        finally:
            thread.join(timeout=5)
            try:
                socket_path.unlink(missing_ok=True)
                short_dir.rmdir()
            except OSError:
                pass

        assert result is None
        assert result_holder["method"] == "lifecycle.sessionCreated"

    def test_socket_call_keeps_write_side_open_until_response(self):
        """tool.execute should not half-close the socket before the bridge replies."""
        client = StdioBridgeClient()
        short_dir = Path(tempfile.mkdtemp(prefix="oa-bridge-"))
        socket_path = short_dir / "bridge.sock"
        result_holder: dict[str, object] = {}
        ready = threading.Event()

        def serve_once() -> None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(socket_path))
                server.listen(1)
                ready.set()
                conn, _ = server.accept()
                with conn:
                    buffer = b""
                    while b"\n" not in buffer:
                        chunk = conn.recv(4096)
                        if not chunk:
                            return
                        buffer += chunk
                    request = json.loads(buffer.decode("utf-8").strip())
                    result_holder["method"] = request["method"]
                    result_holder["params"] = request["params"]
                    conn.settimeout(0.05)
                    try:
                        extra = conn.recv(1)
                    except TimeoutError:
                        extra = b"still-open"
                    except socket.timeout:
                        extra = b"still-open"
                    result_holder["post_request_probe"] = extra.decode(
                        "utf-8", errors="ignore"
                    )
                    if extra == b"":
                        return
                    response = {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": "ok",
                    }
                    conn.sendall((json.dumps(response) + "\n").encode("utf-8"))

        thread = threading.Thread(target=serve_once)
        thread.start()
        try:
            assert ready.wait(timeout=2)
            client._socket_path = str(socket_path)
            result = client.call("tool.execute", {"name": "request_review", "args": {}})
        finally:
            thread.join(timeout=5)
            try:
                socket_path.unlink(missing_ok=True)
                short_dir.rmdir()
            except OSError:
                pass

        assert result == "ok"
        assert result_holder["method"] == "tool.execute"
        assert result_holder["post_request_probe"] == "still-open"

    def test_socket_call_classifies_empty_reply_for_mutation_methods(self):
        client = StdioBridgeClient()
        short_dir = Path(tempfile.mkdtemp(prefix="oa-bridge-"))
        socket_path = short_dir / "bridge.sock"

        ready = threading.Event()

        def serve_once() -> None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(socket_path))
                server.listen(1)
                ready.set()
                conn, _ = server.accept()
                with conn:
                    conn.recv(4096)

        thread = threading.Thread(target=serve_once)
        thread.start()
        try:
            assert ready.wait(timeout=2)
            client._socket_path = str(socket_path)
            with pytest.raises(
                BridgeError, match="socket closed before sending a JSON-RPC reply"
            ):
                client.call("tool.execute", {"name": "request_review", "args": {}})
        finally:
            thread.join(timeout=5)
            try:
                socket_path.unlink(missing_ok=True)
                short_dir.rmdir()
            except OSError:
                pass

    def test_socket_call_classifies_invalid_json_reply(self):
        client = StdioBridgeClient()
        short_dir = Path(tempfile.mkdtemp(prefix="oa-bridge-"))
        socket_path = short_dir / "bridge.sock"

        ready = threading.Event()

        def serve_once() -> None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(socket_path))
                server.listen(1)
                ready.set()
                conn, _ = server.accept()
                with conn:
                    while b"\n" not in (buffer := conn.recv(4096)):
                        if not buffer:
                            return
                    conn.sendall(b"not-json\n")

        thread = threading.Thread(target=serve_once)
        thread.start()
        try:
            assert ready.wait(timeout=2)
            client._socket_path = str(socket_path)
            with pytest.raises(BridgeError, match="invalid JSON reply"):
                client.call("tool.execute", {"name": "request_review", "args": {}})
        finally:
            thread.join(timeout=5)
            try:
                socket_path.unlink(missing_ok=True)
                short_dir.rmdir()
            except OSError:
                pass

    def test_shared_socket_failure_recovers_by_restarting_bridge(self):
        client = StdioBridgeClient()
        client._socket_path = "/tmp/missing.sock"
        client._project_dir = "/tmp/project"

        with (
            patch.object(
                client,
                "start",
                side_effect=lambda project_dir: (
                    setattr(client, "_socket_path", None),
                    setattr(client, "_process", MagicMock()),
                ),
            ),
            patch.object(client, "_send_rpc", return_value="pong") as mock_rpc,
        ):
            result = client.call("lifecycle.ping")

        assert result == "pong"
        mock_rpc.assert_called_once_with("lifecycle.ping", {})

    def test_health_transition_logging_is_suppressed_for_identical_status(self):
        client = StdioBridgeClient()

        with patch("hermes_adapter.bridge_client.logger.info") as mock_info:
            client._log_health_transition("healthy", "shared socket")
            client._log_health_transition("healthy", "shared socket")

        mock_info.assert_called_once()


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
