"""
conftest.py — Shared fixtures for Hermes adapter tests.

Provides mock implementations of BridgeClient and HermesContext that
satisfy the Protocol contracts without requiring a real bridge subprocess
or Hermes runtime.
"""

from __future__ import annotations

import json
import pytest
from typing import Any
from unittest.mock import AsyncMock, MagicMock


# ---------------------------------------------------------------------------
# Mock BridgeClient
# ---------------------------------------------------------------------------


class MockBridgeClient:
    """Mock bridge client that records calls and returns canned responses.

    Satisfies the BridgeClient Protocol from types.py.

    Usage:
        bridge = MockBridgeClient()
        bridge.set_response("tool.execute", "Mode set to GREENFIELD.")
        result = bridge.call("tool.execute", {"name": "select_mode", ...})
    """

    def __init__(self) -> None:
        self._started = False
        self._project_dir: str | None = None
        self._responses: dict[str, Any] = {}
        self._calls: list[tuple[str, dict[str, Any] | None]] = []
        self._alive = True

    def start(self, project_dir: str) -> None:
        self._started = True
        self._project_dir = project_dir

    def ensure_started(self, project_dir: str) -> None:
        self.start(project_dir)

    def ensure_session(
        self, session_id: str, project_dir: str, agent: str = "artisan"
    ) -> None:
        self.start(project_dir)
        self._calls.append(
            ("lifecycle.sessionCreated", {"sessionId": session_id, "agent": agent})
        )

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self._calls.append((method, params))
        if method in self._responses:
            resp = self._responses[method]
            if callable(resp):
                return resp(params)
            return resp
        return None

    def shutdown(self) -> None:
        self._started = False
        self._alive = False

    @property
    def is_alive(self) -> bool:
        return self._alive and self._started

    # Test helpers

    def set_response(self, method: str, response: Any) -> None:
        """Set a canned response for a given method."""
        self._responses[method] = response

    def set_response_fn(self, method: str, fn: Any) -> None:
        """Set a callable that receives params and returns a response."""
        self._responses[method] = fn

    def get_calls(
        self, method: str | None = None
    ) -> list[tuple[str, dict[str, Any] | None]]:
        """Get recorded calls, optionally filtered by method."""
        if method is None:
            return list(self._calls)
        return [(m, p) for m, p in self._calls if m == method]

    def reset(self) -> None:
        """Clear recorded calls and responses."""
        self._calls.clear()
        self._responses.clear()


# ---------------------------------------------------------------------------
# Mock HermesContext
# ---------------------------------------------------------------------------


class MockHermesContext:
    """Mock Hermes plugin context for testing.

    Satisfies the HermesContext Protocol from types.py.
    Records all tool and hook registrations for assertion.
    """

    def __init__(
        self,
        session_id: str = "test-session",
        project_dir: str = "/tmp/test-project",
    ) -> None:
        self._session_id = session_id
        self._project_dir = project_dir
        self._tools: dict[str, dict[str, Any]] = {}
        self._hooks: dict[str, list[Any]] = {}
        self._original_handlers: dict[str, Any] = {}

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def project_dir(self) -> str:
        return self._project_dir

    def register_tool(
        self,
        name: str,
        toolset: str,
        schema: dict[str, Any],
        handler: Any,
        check_fn: Any = None,
        requires_env: list[Any] | None = None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
    ) -> None:
        self._tools[name] = {
            "toolset": toolset,
            "name": name,
            "description": description or schema.get("description", ""),
            "parameters": schema.get("parameters", {}),
            "schema": schema,
            "handler": handler,
        }

    def register_hook(self, hook_name: str, callback: Any) -> None:
        if hook_name not in self._hooks:
            self._hooks[hook_name] = []
        self._hooks[hook_name].append(callback)

    def get_tool_handler(self, name: str) -> Any | None:
        return self._original_handlers.get(name)

    # Test helpers

    def set_original_handler(self, name: str, handler: Any) -> None:
        """Set a mock original handler for get_tool_handler()."""
        self._original_handlers[name] = handler

    def get_registered_tool(self, name: str) -> dict[str, Any] | None:
        """Get a registered tool's full registration dict."""
        return self._tools.get(name)

    def get_registered_hooks(self, event: str) -> list[Any]:
        """Get all handlers registered for an event."""
        return self._hooks.get(event, [])

    @property
    def registered_tool_names(self) -> list[str]:
        """All registered tool names."""
        return list(self._tools.keys())


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_bridge() -> MockBridgeClient:
    """Fresh mock bridge client."""
    return MockBridgeClient()


@pytest.fixture
def mock_ctx() -> MockHermesContext:
    """Fresh mock Hermes context."""
    return MockHermesContext()


@pytest.fixture
def started_bridge(mock_bridge: MockBridgeClient) -> MockBridgeClient:
    """Mock bridge client that has been started."""
    mock_bridge.start("/tmp/test-project")
    return mock_bridge
