"""
types.py — Type definitions and protocols for the Hermes adapter.

Defines the contracts between components. All inter-component communication
goes through these types. Implementation modules import from here.
"""
from __future__ import annotations

import json
from typing import Any, Protocol, TypedDict, runtime_checkable


# ---------------------------------------------------------------------------
# JSON-RPC types
# ---------------------------------------------------------------------------

class JsonRpcRequest(TypedDict):
    jsonrpc: str  # always "2.0"
    method: str
    params: dict[str, Any]
    id: int


class JsonRpcError(TypedDict, total=False):
    code: int
    message: str
    data: Any


class JsonRpcResponse(TypedDict, total=False):
    jsonrpc: str
    result: Any
    error: JsonRpcError
    id: int


# ---------------------------------------------------------------------------
# Bridge client protocol
# ---------------------------------------------------------------------------

@runtime_checkable
class BridgeClient(Protocol):
    """Transport layer to the bridge subprocess."""

    def start(self, project_dir: str) -> None:
        """Spawn the bridge subprocess and send lifecycle.init."""
        ...

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send a JSON-RPC request and return the result. Raises on error."""
        ...

    def shutdown(self) -> None:
        """Send lifecycle.shutdown and terminate the subprocess."""
        ...

    @property
    def is_alive(self) -> bool:
        """True if the bridge subprocess is running."""
        ...


# ---------------------------------------------------------------------------
# Guard result types
# ---------------------------------------------------------------------------

class GuardCheckResult(TypedDict):
    allowed: bool
    reason: str
    phase: str
    phaseState: str


class GuardBlockedError(TypedDict):
    error: str
    phase: str
    phaseState: str


# ---------------------------------------------------------------------------
# Hermes plugin context protocol
#
# Hermes v0.5.0 passes a context object to register(). We define a Protocol
# so the adapter doesn't depend on Hermes internals. Tests can provide a
# mock that satisfies this protocol.
# ---------------------------------------------------------------------------

class ToolDefinition(TypedDict):
    name: str
    description: str
    parameters: dict[str, Any]


class ToolRegistration(TypedDict):
    """What register_tool() expects."""
    toolset: str
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Any  # async callable(args: dict) -> str


class HookRegistration(TypedDict, total=False):
    """What register_hook() expects."""
    name: str
    event: str
    handler: Any  # callable or async callable


@runtime_checkable
class HermesContext(Protocol):
    """Subset of the Hermes plugin context used by the adapter."""

    @property
    def session_id(self) -> str:
        """Current Hermes session identifier."""
        ...

    @property
    def project_dir(self) -> str:
        """Absolute path to the project directory."""
        ...

    def register_tool(
        self,
        *,
        toolset: str,
        name: str,
        description: str,
        parameters: dict[str, Any],
        handler: Any,
    ) -> None:
        """Register a tool with Hermes."""
        ...

    def register_hook(self, *, event: str, handler: Any) -> None:
        """Register a lifecycle or LLM hook."""
        ...

    def get_tool_handler(self, name: str) -> Any | None:
        """Get the original handler for a built-in tool (for wrapping)."""
        ...


# ---------------------------------------------------------------------------
# Workflow state (subset returned by state.get)
# ---------------------------------------------------------------------------

class WorkflowStateSummary(TypedDict, total=False):
    phase: str
    phaseState: str
    mode: str | None
    featureName: str | None
    currentTaskId: str | None
    iterationCount: int
    approvedArtifacts: dict[str, str]


# ---------------------------------------------------------------------------
# Bridge communication error
# ---------------------------------------------------------------------------

class BridgeError(Exception):
    """Raised when bridge communication fails (subprocess died, parse error, timeout)."""

    def __init__(self, message: str, *, recoverable: bool = True) -> None:
        super().__init__(message)
        self.recoverable = recoverable


# ---------------------------------------------------------------------------
# Helper: structured error response for LLM consumption
# ---------------------------------------------------------------------------

def make_error_response(error: str, phase: str = "", phase_state: str = "") -> str:
    """Build a JSON error string that the LLM can parse."""
    d: dict[str, str] = {"error": error}
    if phase:
        d["phase"] = phase
    if phase_state:
        d["phaseState"] = phase_state
    return json.dumps(d)
