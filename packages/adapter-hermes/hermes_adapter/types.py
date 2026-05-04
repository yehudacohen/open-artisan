"""
types.py — Type definitions and protocols for the Hermes adapter.

Defines the contracts between components. All inter-component communication
goes through these types. Implementation modules import from here.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Protocol, TypedDict, TypeAlias, runtime_checkable

JsonPrimitive: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonPrimitive | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
ToolHandler: TypeAlias = Callable[..., str]
HookCallback: TypeAlias = Callable[..., object]


# ---------------------------------------------------------------------------
# JSON-RPC types
# ---------------------------------------------------------------------------


class JsonRpcRequest(TypedDict):
    jsonrpc: str  # always "2.0"
    method: str
    params: JsonObject
    id: int


class JsonRpcError(TypedDict, total=False):
    code: int
    message: str
    data: JsonValue


class JsonRpcResponse(TypedDict, total=False):
    jsonrpc: str
    result: JsonValue
    error: JsonRpcError
    id: int


class BridgeClientLease(TypedDict, total=False):
    clientId: str
    clientKind: str
    sessionId: str
    attachedAt: str
    lastSeenAt: str
    processInfo: JsonObject
    shutdownIntent: bool


class BridgeLeaseSnapshot(TypedDict):
    bridgeInstanceId: str
    clients: list[BridgeClientLease]


class BridgeMetadata(TypedDict, total=False):
    version: int
    bridgeInstanceId: str
    projectDir: str
    stateDir: str
    transport: str
    socketPath: str
    pid: int
    startedAt: str
    protocolVersion: str
    adapterCompatibility: dict[str, bool]
    lastHeartbeatAt: str


class BridgeDiscoveryResult(TypedDict, total=False):
    kind: str
    reason: str
    stalePaths: list[str]
    previousPid: int
    metadata: BridgeMetadata
    leases: BridgeLeaseSnapshot


class AttachBridgeResult(TypedDict, total=False):
    kind: str
    reason: str
    metadata: BridgeMetadata
    lease: BridgeClientLease
    leases: BridgeLeaseSnapshot


class BridgeShutdownEligibility(TypedDict, total=False):
    allowed: bool
    activeClientCount: int
    blockingClientIds: list[str]
    reason: str


class BridgeRecoveryResult(TypedDict, total=False):
    kind: str
    reason: str
    clearedPaths: list[str]
    discovery: BridgeDiscoveryResult
    pluginReloaded: bool


class AttachBridgeParams(TypedDict, total=False):
    projectDir: str
    stateDir: str
    clientId: str
    clientKind: str
    sessionId: str
    processInfo: JsonObject
    capabilities: dict[str, bool]


class DetachBridgeParams(TypedDict, total=False):
    projectDir: str
    stateDir: str
    clientId: str
    reason: str
    requestedAt: str


# ---------------------------------------------------------------------------
# Bridge client protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class BridgeClient(Protocol):
    """Transport layer to the bridge subprocess."""

    def start(self, project_dir: str) -> None:
        """Spawn the bridge subprocess and send lifecycle.init."""
        ...

    def call(self, method: str, params: JsonObject | None = None) -> JsonValue:
        """Send a JSON-RPC request and return the result. Raises on error."""
        ...

    def attach_or_start(self, params: AttachBridgeParams) -> AttachBridgeResult:
        """Attach the current adapter client to a shared bridge or start one."""
        ...

    def detach_client(self, params: DetachBridgeParams) -> BridgeShutdownEligibility:
        """Detach a client without assuming the bridge should fully shut down."""
        ...

    def discover_bridge(
        self, project_dir: str, state_dir: str
    ) -> BridgeDiscoveryResult:
        """Inspect existing local bridge metadata and liveness for a project."""
        ...

    def recover_stale_bridge(self, project_dir: str) -> BridgeRecoveryResult:
        """Clear stale or malformed shared-bridge runtime files for a project."""
        ...

    def ensure_started(self, project_dir: str) -> None:
        """Ensure an existing bridge transport is healthy or start one."""
        ...

    def ensure_session(
        self, session_id: str, project_dir: str, agent: str = "artisan"
    ) -> None:
        """Ensure the current session is registered once per healthy runtime."""
        ...

    def clear_session(self, session_id: str, project_dir: str) -> None:
        """Forget local ensured-session tracking for a completed session."""
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
    parameters: JsonObject


class ToolRegistration(TypedDict):
    """What register_tool() expects."""

    toolset: str
    name: str
    description: str
    schema: JsonObject
    handler: ToolHandler


class HookRegistration(TypedDict, total=False):
    """What register_hook() expects."""

    name: str
    event: str
    handler: HookCallback


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
        name: str,
        toolset: str,
        schema: JsonObject,
        handler: ToolHandler,
        check_fn: HookCallback | None = None,
        requires_env: list[str] | None = None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
    ) -> None:
        """Register a tool with Hermes."""
        ...

    def register_hook(self, hook_name: str, callback: HookCallback) -> None:
        """Register a lifecycle or LLM hook."""
        ...

    def get_tool_handler(self, name: str) -> ToolHandler | None:
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
