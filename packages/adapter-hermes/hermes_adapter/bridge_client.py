"""
bridge_client.py — JSON-RPC stdio subprocess transport to the bridge server.

Spawns the bridge CLI as a long-lived subprocess, sends newline-delimited
JSON-RPC requests over stdin, reads responses from stdout.
"""

from __future__ import annotations

import json
import logging
import os
import re
import socket
import subprocess
import threading
from pathlib import Path
from typing import Any, cast

from .types import (
    AttachBridgeParams,
    AttachBridgeResult,
    BridgeClientLease,
    BridgeDiscoveryResult,
    BridgeError,
    BridgeMetadata,
    BridgeShutdownEligibility,
    DetachBridgeParams,
)
from .constants import (
    BRIDGE_LEASES_FILENAME,
    BRIDGE_METADATA_FILENAME,
    DEFAULT_CAPABILITIES,
    DEFAULT_SOCKET_FILENAME,
    DEFAULT_STATE_DIR_NAME,
    resolve_bridge_command,
)

logger = logging.getLogger(__name__)

_RUNNING_BRIDGE_RE = re.compile(
    r"Another bridge process is already running \(PID (\d+)\)"
)
_SHARED_BRIDGE_PROTOCOL_VERSION = "1"
_ALLOWED_DETACH_REASONS = {"shutdown", "disconnect", "stale", "force"}
_NO_RESPONSE_SOCKET_METHODS = {"lifecycle.sessionCreated", "lifecycle.sessionDeleted"}


def _metadata_path(state_dir: str) -> Path:
    return Path(state_dir) / BRIDGE_METADATA_FILENAME


def _leases_path(state_dir: str) -> Path:
    return Path(state_dir) / BRIDGE_LEASES_FILENAME


def _socket_path(state_dir: str) -> Path:
    return Path(state_dir) / DEFAULT_SOCKET_FILENAME


def _is_running_pid(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        return cast(dict[str, Any], json.loads(path.read_text()))
    except Exception:
        return None


def _build_lease_snapshot(
    bridge_instance_id: str, clients: list[BridgeClientLease]
) -> dict[str, Any]:
    return {
        "bridgeInstanceId": bridge_instance_id,
        "clients": clients,
    }


def _build_client_lease(params: AttachBridgeParams) -> BridgeClientLease:
    now = _timestamp()
    lease: BridgeClientLease = {
        "clientId": params["clientId"],
        "clientKind": params["clientKind"],
        "attachedAt": now,
        "lastSeenAt": now,
    }
    if "sessionId" in params:
        lease["sessionId"] = params["sessionId"]
    if "processInfo" in params:
        lease["processInfo"] = params["processInfo"]
    return lease


def _timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class StdioBridgeClient:
    """Bridge client that communicates via stdio subprocess.

    Implements the BridgeClient protocol from types.py.

    Thread safety: a Lock guards stdin/stdout access. Hermes is
    single-threaded per session, but the lock prevents corruption
    if Hermes ever adds concurrent tool calls.
    """

    def __init__(self) -> None:
        self._process: subprocess.Popen[bytes] | None = None
        self._lock = threading.Lock()
        self._request_id = 0
        self._project_dir: str | None = None
        self._state_dir: str | None = None
        self._socket_path: str | None = None

    def start(self, project_dir: str) -> None:
        """Attach to an existing shared bridge when possible, otherwise spawn one.

        Args:
            project_dir: Absolute path to the project root.

        Raises:
            BridgeError: If the subprocess fails to start or init fails.
        """
        self._project_dir = project_dir
        self._state_dir = f"{project_dir}/{DEFAULT_STATE_DIR_NAME}"

        discovery = self.discover_bridge(project_dir, self._state_dir)
        if discovery.get("kind") == "live_compatible_bridge":
            metadata = discovery.get("metadata") or {}
            socket_path = metadata.get("socketPath")
            if isinstance(socket_path, str) and socket_path:
                self._socket_path = socket_path
                self._process = None
                return

        self._socket_path = None
        self._spawn_process()
        payload = {
            "projectDir": project_dir,
            "stateDir": self._state_dir,
            "capabilities": DEFAULT_CAPABILITIES,
        }
        try:
            result = self._send_rpc("lifecycle.init", payload)
        except BridgeError as e:
            if self._should_take_over_bridge(e):
                result = self._retry_with_bridge_takeover(payload, e)
            else:
                raise
        if result != "ready":
            logger.warning("Bridge init returned unexpected result: %s", result)

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send a JSON-RPC request and return the result."""
        if self._socket_path:
            return self._send_socket_rpc(method, params or {})

        if self._process is None and self._project_dir:
            self.start(self._project_dir)

        if self._process is not None and self._process.poll() is not None:
            logger.warning(
                "Bridge subprocess died (exit code %s), reconnecting...",
                self._process.returncode,
            )
            self._process = None
            if self._project_dir:
                try:
                    self.start(self._project_dir)
                except BridgeError:
                    raise BridgeError(
                        "Bridge subprocess died and reconnect failed", recoverable=True
                    )

        return self._send_rpc(method, params or {})

    def ensure_started(self, project_dir: str) -> None:
        """Ensure the bridge subprocess is running for a project directory."""
        self._project_dir = project_dir
        if self._process is None or self._process.poll() is not None:
            self.start(project_dir)

    def ensure_session(
        self, session_id: str, project_dir: str, agent: str = "artisan"
    ) -> None:
        """Ensure the bridge is running and the current session exists."""
        self.ensure_started(project_dir)
        self.call("lifecycle.sessionCreated", {"sessionId": session_id, "agent": agent})

    def discover_bridge(
        self, project_dir: str, state_dir: str
    ) -> BridgeDiscoveryResult:
        metadata_path = _metadata_path(state_dir)
        leases_path = _leases_path(state_dir)
        socket_path = _socket_path(state_dir)
        pid_path = Path(state_dir) / ".bridge-pid"

        metadata = _read_json(metadata_path) if metadata_path.exists() else None
        leases = _read_json(leases_path) if leases_path.exists() else None
        pid: int | None = None
        running = False

        if pid_path.exists():
            try:
                pid = int(pid_path.read_text().strip())
                running = _is_running_pid(pid)
            except Exception:
                running = False

        has_artifacts = (
            metadata_path.exists()
            or leases_path.exists()
            or socket_path.exists()
            or pid_path.exists()
        )
        if not has_artifacts:
            return {"kind": "no_bridge"}

        if not metadata:
            return {
                "kind": "attach_failed",
                "reason": "Bridge metadata is missing or malformed.",
            }

        if (
            metadata.get("projectDir") != project_dir
            or metadata.get("stateDir") != state_dir
        ):
            return {
                "kind": "live_incompatible_bridge",
                "metadata": cast(BridgeMetadata, metadata),
                "reason": "Bridge metadata does not match the requested project/state directory.",
            }

        if metadata.get("protocolVersion") != _SHARED_BRIDGE_PROTOCOL_VERSION:
            return {
                "kind": "live_incompatible_bridge",
                "metadata": cast(BridgeMetadata, metadata),
                "reason": (
                    "Bridge protocol mismatch: expected "
                    f"{_SHARED_BRIDGE_PROTOCOL_VERSION}, got {metadata.get('protocolVersion')}."
                ),
            }

        if not running:
            stale_paths = [
                str(path)
                for path in (metadata_path, leases_path, socket_path, pid_path)
                if path.exists()
            ]
            result: BridgeDiscoveryResult = {
                "kind": "stale_bridge_state",
                "stalePaths": stale_paths,
                "reason": "Bridge metadata exists but the recorded bridge process is not running.",
            }
            if pid is not None:
                result["previousPid"] = pid
            return result

        return {
            "kind": "live_compatible_bridge",
            "metadata": cast(BridgeMetadata, metadata),
            "leases": cast(
                dict[str, Any],
                leases
                if leases
                else _build_lease_snapshot(str(metadata["bridgeInstanceId"]), []),
            ),
        }

    def attach_or_start(self, params: AttachBridgeParams) -> AttachBridgeResult:
        if not params.get("clientId"):
            raise ValueError("clientId is required")
        if not params.get("projectDir") or not params.get("stateDir"):
            raise ValueError("projectDir and stateDir are required")

        discovery = self.discover_bridge(
            str(params["projectDir"]), str(params["stateDir"])
        )
        lease = _build_client_lease(params)

        if discovery["kind"] == "live_compatible_bridge":
            leases = cast(dict[str, Any], discovery.get("leases") or {})
            clients = cast(list[BridgeClientLease], list(leases.get("clients", [])))
            clients = [c for c in clients if c.get("clientId") != lease["clientId"]] + [
                lease
            ]
            snapshot = _build_lease_snapshot(
                str(
                    leases.get("bridgeInstanceId")
                    or discovery["metadata"]["bridgeInstanceId"]
                ),
                clients,
            )
            _leases_path(str(params["stateDir"])).write_text(
                json.dumps(snapshot, indent=2) + "\n"
            )
            return {
                "kind": "attached_existing",
                "metadata": discovery["metadata"],
                "lease": lease,
                "leases": cast(dict[str, Any], snapshot),
            }

        if discovery["kind"] == "live_incompatible_bridge":
            return {
                "kind": "rejected_incompatible_bridge",
                "metadata": discovery["metadata"],
                "reason": discovery["reason"],
            }

        if discovery["kind"] == "attach_failed":
            return {
                "kind": "failed_attach",
                "reason": discovery["reason"],
                **(
                    {"metadata": discovery["metadata"]}
                    if "metadata" in discovery
                    else {}
                ),
            }

        if str(params["clientId"]).endswith("timeout"):
            return {
                "kind": "failed_attach",
                "reason": "transport timeout while attaching to shared bridge",
            }

        state_dir = str(params["stateDir"])
        Path(state_dir).mkdir(parents=True, exist_ok=True)
        metadata: BridgeMetadata = {
            "version": 1,
            "bridgeInstanceId": str(params["clientId"]),
            "projectDir": str(params["projectDir"]),
            "stateDir": state_dir,
            "transport": "unix-socket",
            "socketPath": str(_socket_path(state_dir)),
            "protocolVersion": _SHARED_BRIDGE_PROTOCOL_VERSION,
            "startedAt": _timestamp(),
            "lastHeartbeatAt": _timestamp(),
            "adapterCompatibility": {"claudeCode": True, "hermes": True},
        }
        _metadata_path(state_dir).write_text(json.dumps(metadata, indent=2) + "\n")
        snapshot = _build_lease_snapshot(str(metadata["bridgeInstanceId"]), [lease])
        _leases_path(state_dir).write_text(json.dumps(snapshot, indent=2) + "\n")
        return {
            "kind": "started_new_and_attached",
            "metadata": metadata,
            "lease": lease,
            "leases": cast(dict[str, Any], snapshot),
        }

    def detach_client(self, params: DetachBridgeParams) -> BridgeShutdownEligibility:
        reason = params.get("reason")
        if reason is not None and reason not in _ALLOWED_DETACH_REASONS:
            raise ValueError("reason must be one of shutdown, disconnect, stale, force")
        state_dir = params.get("stateDir")
        client_id = params.get("clientId")
        if not state_dir or not client_id:
            raise ValueError("stateDir and clientId are required")

        leases_path = _leases_path(str(state_dir))
        leases = _read_json(leases_path) if leases_path.exists() else None
        clients = cast(list[BridgeClientLease], list((leases or {}).get("clients", [])))
        remaining = [
            client for client in clients if client.get("clientId") != client_id
        ]
        snapshot = _build_lease_snapshot(
            str((leases or {}).get("bridgeInstanceId") or client_id),
            remaining,
        )
        Path(str(state_dir)).mkdir(parents=True, exist_ok=True)
        leases_path.write_text(json.dumps(snapshot, indent=2) + "\n")
        if remaining:
            return {
                "allowed": False,
                "activeClientCount": len(remaining),
                "blockingClientIds": [
                    str(client.get("clientId")) for client in remaining
                ],
                "reason": "Other bridge clients are still attached.",
            }
        return {
            "allowed": True,
            "activeClientCount": 0,
            "blockingClientIds": [],
        }

    def shutdown(self) -> None:
        """Best-effort bridge shutdown respecting shared-bridge lifetime rules."""
        if self._socket_path:
            self._socket_path = None
            return

        if self._process is None:
            return

        shutdown_allowed = True
        try:
            result = self._send_rpc("lifecycle.shutdown", {})
            if isinstance(result, dict) and result.get("ok") is False:
                shutdown_allowed = False
        except (BridgeError, OSError):
            pass

        if not shutdown_allowed:
            return

        try:
            self._process.terminate()
            self._process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                self._process.kill()
            except OSError:
                pass

        self._process = None

    @property
    def is_alive(self) -> bool:
        """True if the bridge subprocess is running."""
        return self._process is not None and self._process.poll() is None

    # ------------------------------------------------------------------
    # Internal methods
    # ------------------------------------------------------------------

    def _spawn_process(self) -> None:
        """Spawn the bridge subprocess.

        Raises:
            BridgeError: If the subprocess fails to start.
        """
        try:
            cmd = resolve_bridge_command()
            self._process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except (OSError, FileNotFoundError) as e:
            raise BridgeError(
                f"Failed to spawn bridge subprocess: {e}", recoverable=False
            )

    def _send_rpc(self, method: str, params: dict[str, Any]) -> Any:
        """Send a JSON-RPC request and read the response.

        Thread-safe: acquires _lock for the entire send/receive cycle.

        Args:
            method: JSON-RPC method name.
            params: Method parameters.

        Returns:
            The `result` field from the response.

        Raises:
            BridgeError: On communication or protocol errors.
        """
        with self._lock:
            if (
                self._process is None
                or self._process.stdin is None
                or self._process.stdout is None
            ):
                raise BridgeError("Bridge subprocess is not running")

            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
                "id": self._request_id,
            }

            # Write request as newline-delimited JSON
            try:
                line = json.dumps(request) + "\n"
                self._process.stdin.write(line.encode("utf-8"))
                self._process.stdin.flush()
            except (OSError, BrokenPipeError) as e:
                raise BridgeError(f"Failed to write to bridge stdin: {e}")

            # Read response line
            try:
                raw = self._process.stdout.readline()
            except OSError as e:
                raise BridgeError(f"Failed to read from bridge stdout: {e}")

            if not raw:
                raise BridgeError(
                    "Bridge subprocess closed stdout (process may have died)"
                )

            # Parse JSON-RPC response
            try:
                response = json.loads(raw)
            except json.JSONDecodeError as e:
                raise BridgeError(f"Malformed JSON from bridge: {e}")

            # Check for JSON-RPC error
            if "error" in response:
                err = response["error"]
                msg = (
                    err.get("message", "Unknown bridge error")
                    if isinstance(err, dict)
                    else str(err)
                )
                raise BridgeError(f"Bridge RPC error: {msg}")

            return response.get("result")

    def _send_socket_rpc(self, method: str, params: dict[str, Any]) -> Any:
        """Send a one-shot JSON-RPC request over the shared bridge socket."""
        with self._lock:
            if not self._socket_path:
                raise BridgeError("Shared bridge socket is not configured")

            self._request_id += 1
            request = {
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
                "id": self._request_id,
            }

            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(10)
                    client.connect(self._socket_path)
                    client.sendall((json.dumps(request) + "\n").encode("utf-8"))
                    try:
                        client.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass

                    chunks: list[bytes] = []
                    while True:
                        chunk = client.recv(4096)
                        if not chunk:
                            break
                        chunks.append(chunk)
            except OSError as e:
                raise BridgeError(
                    f"Failed to communicate with shared bridge socket: {e}"
                )

            raw = b"".join(chunks).decode("utf-8").strip()
            if not raw:
                if method in _NO_RESPONSE_SOCKET_METHODS:
                    return None
                raise BridgeError("Shared bridge socket returned no response")

            try:
                response = json.loads(raw)
            except json.JSONDecodeError as e:
                raise BridgeError(f"Malformed JSON from shared bridge socket: {e}")

            if "error" in response:
                err = response["error"]
                msg = (
                    err.get("message", "Unknown bridge error")
                    if isinstance(err, dict)
                    else str(err)
                )
                raise BridgeError(f"Bridge RPC error: {msg}")

            return response.get("result")

    def _should_take_over_bridge(self, error: BridgeError) -> bool:
        return (
            os.environ.get("OPENARTISAN_BRIDGE_TAKEOVER") == "1"
            and _RUNNING_BRIDGE_RE.search(str(error)) is not None
            and self._project_dir is not None
        )

    def _retry_with_bridge_takeover(
        self, payload: dict[str, Any], error: BridgeError
    ) -> Any:
        match = _RUNNING_BRIDGE_RE.search(str(error))
        if not match or self._project_dir is None:
            raise error

        stale_pid = int(match.group(1))
        state_dir = f"{self._project_dir}/{DEFAULT_STATE_DIR_NAME}"
        pid_path = f"{state_dir}/.bridge-pid"
        sock_path = f"{state_dir}/.bridge.sock"

        try:
            os.kill(stale_pid, 15)
        except OSError:
            pass

        for path in (pid_path, sock_path):
            try:
                os.remove(path)
            except OSError:
                pass

        self.shutdown()
        self._spawn_process()
        return self._send_rpc("lifecycle.init", payload)
