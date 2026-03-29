"""
bridge_client.py — JSON-RPC stdio subprocess transport to the bridge server.

Spawns the bridge CLI as a long-lived subprocess, sends newline-delimited
JSON-RPC requests over stdin, reads responses from stdout.
"""
from __future__ import annotations

import json
import logging
import subprocess
import threading
from typing import Any

from .types import BridgeError
from .constants import resolve_bridge_command, DEFAULT_CAPABILITIES, DEFAULT_STATE_DIR_NAME

logger = logging.getLogger(__name__)


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

    def start(self, project_dir: str) -> None:
        """Spawn bridge subprocess and send lifecycle.init.

        Args:
            project_dir: Absolute path to the project root.

        Raises:
            BridgeError: If the subprocess fails to start or init fails.
        """
        self._project_dir = project_dir
        self._spawn_process()
        # Initialize the bridge with project config
        result = self._send_rpc("lifecycle.init", {
            "projectDir": project_dir,
            "stateDir": f"{project_dir}/{DEFAULT_STATE_DIR_NAME}",
            "capabilities": DEFAULT_CAPABILITIES,
        })
        if result != "ready":
            logger.warning("Bridge init returned unexpected result: %s", result)

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send a JSON-RPC request and return the result.

        Auto-reconnects if the subprocess has died since the last call.

        Args:
            method: JSON-RPC method name (e.g. "tool.execute").
            params: Method parameters.

        Returns:
            The `result` field from the JSON-RPC response.

        Raises:
            BridgeError: On communication failure (subprocess died,
                parse error, timeout).
        """
        # Auto-reconnect if the process has died
        if self._process is not None and self._process.poll() is not None:
            logger.warning("Bridge subprocess died (exit code %s), reconnecting...", self._process.returncode)
            self._process = None
            if self._project_dir:
                try:
                    self.start(self._project_dir)
                except BridgeError:
                    raise BridgeError("Bridge subprocess died and reconnect failed", recoverable=True)

        return self._send_rpc(method, params or {})

    def shutdown(self) -> None:
        """Send lifecycle.shutdown and terminate the subprocess.

        Safe to call multiple times or if the process is already dead.
        """
        if self._process is None:
            return

        try:
            self._send_rpc("lifecycle.shutdown", {})
        except (BridgeError, OSError):
            pass  # Best-effort — process may already be dead

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
            raise BridgeError(f"Failed to spawn bridge subprocess: {e}", recoverable=False)

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
            if self._process is None or self._process.stdin is None or self._process.stdout is None:
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
                raise BridgeError("Bridge subprocess closed stdout (process may have died)")

            # Parse JSON-RPC response
            try:
                response = json.loads(raw)
            except json.JSONDecodeError as e:
                raise BridgeError(f"Malformed JSON from bridge: {e}")

            # Check for JSON-RPC error
            if "error" in response:
                err = response["error"]
                msg = err.get("message", "Unknown bridge error") if isinstance(err, dict) else str(err)
                raise BridgeError(f"Bridge RPC error: {msg}")

            return response.get("result")
