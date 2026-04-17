"""
continuation.py — interface contracts for Hermes autonomous continuation.

This module defines the adapter-level continuation request/result types used to
separate bridge-owned continuation decisions from Hermes-owned continuation
execution.

The implementation phase will wire these contracts into runtime behavior for:
- direct CLI/session continuation inside Hermes-native runtime primitives
- gateway-owned messaging continuation handoff
"""

from __future__ import annotations

from typing import Literal, Protocol, TypedDict, runtime_checkable

from .types import JsonObject

ContinuationSurfaceKind = Literal[
    "direct_cli",
    "gateway_messaging",
    "unknown",
]

ContinuationStrategyKind = Literal[
    "direct_runner",
    "gateway_handoff",
    "none",
]

ContinuationOutcomeKind = Literal[
    "continued",
    "handoff_requested",
    "skipped",
    "blocked",
    "failed",
]


class ContinuationSurface(TypedDict, total=False):
    """Normalized description of where the current Hermes session originated."""

    kind: ContinuationSurfaceKind
    platform: str
    source: str
    reason: str


class GatewayRoutingInfo(TypedDict, total=False):
    """Routing metadata required for gateway-owned continuation delivery."""

    platform: str
    chatId: str
    threadId: str
    userId: str
    messageId: str
    sessionOrigin: str


class ContinuationRequest(TypedDict, total=False):
    """Structured continuation input derived from session-end + idle.check data."""

    sessionId: str
    projectDir: str
    agent: str
    idleAction: str
    message: str
    surface: ContinuationSurface
    gatewayRouting: GatewayRoutingInfo
    workflowState: JsonObject
    rawSessionContext: JsonObject


class ContinuationOutcome(TypedDict, total=False):
    """Structured result returned by continuation strategy implementations."""

    kind: ContinuationOutcomeKind
    strategy: ContinuationStrategyKind
    sessionId: str
    detail: str
    missingFields: list[str]
    error: str


@runtime_checkable
class DirectContinuationRunner(Protocol):
    """Runs same-session continuation for direct CLI-originated Hermes sessions."""

    def run(self, request: ContinuationRequest) -> ContinuationOutcome:
        ...


@runtime_checkable
class GatewayContinuationHandoff(Protocol):
    """Delegates continuation of messaging sessions to gateway-owned execution."""

    def handoff(self, request: ContinuationRequest) -> ContinuationOutcome:
        ...


@runtime_checkable
class ContinuationStrategyResolver(Protocol):
    """Chooses the appropriate continuation strategy for a normalized request."""

    def resolve(self, request: ContinuationRequest) -> ContinuationStrategyKind:
        ...
