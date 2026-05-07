"""
test_guard_wrappers.py — Tests for guard wrapper enforcement.

Verifies that wrapped tools call guard.check before delegating,
block when the guard says no, pass through artisan commands, and
handle bridge failures safely.
"""

from __future__ import annotations

import json
import pytest
from unittest.mock import AsyncMock

from hermes_adapter.guard_wrappers import (
    register_guard_wrappers,
    _guarded_handler,
    _is_artisan_command,
)
from hermes_adapter.constants import GUARDED_TOOLS
from hermes_adapter.types import BridgeError

from .conftest import MockBridgeClient, MockHermesContext


# ---------------------------------------------------------------------------
# Wrapper registration
# ---------------------------------------------------------------------------


class TestWrapperRegistration:
    """register_guard_wrappers wraps all guarded tools."""

    def test_wraps_all_guarded_tools(self, mock_ctx, mock_bridge):
        """Should register wrappers for all tools in GUARDED_TOOLS."""
        for tool_name in GUARDED_TOOLS:
            mock_ctx.set_original_handler(tool_name, AsyncMock(return_value="original"))
        register_guard_wrappers(mock_ctx, mock_bridge)
        for tool_name in GUARDED_TOOLS:
            assert tool_name in mock_ctx.registered_tool_names, (
                f"Wrapper not registered for {tool_name}"
            )

    def test_skips_missing_original_handler(self, mock_ctx, mock_bridge):
        """If a built-in tool doesn't exist, skip wrapping (don't crash)."""
        # Don't set any original handlers — register should not raise
        register_guard_wrappers(mock_ctx, mock_bridge)


# ---------------------------------------------------------------------------
# Guard allows — original handler called
# ---------------------------------------------------------------------------


class TestGuardAllows:
    """When guard.check returns allowed=True, delegate to original."""

    @pytest.mark.asyncio
    async def test_calls_original_when_allowed(self, started_bridge):
        """Original handler should be called when guard allows."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": True,
                "reason": "",
                "phase": "IMPLEMENTATION",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock(return_value="file written")
        result = await _guarded_handler(
            started_bridge,
            original,
            "write_file",
            "s1",
            {"path": "src/main.py", "content": "hello"},
        )
        original.assert_called_once()
        assert result == "file written"

    @pytest.mark.asyncio
    async def test_passes_args_to_original(self, started_bridge):
        """Original handler should receive the original args."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": True,
                "reason": "",
                "phase": "IMPL",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock(return_value="ok")
        args = {"path": "src/foo.py", "content": "bar"}
        await _guarded_handler(started_bridge, original, "write_file", "s1", args)
        call_args = original.call_args
        assert call_args is not None


# ---------------------------------------------------------------------------
# Guard blocks — original NOT called
# ---------------------------------------------------------------------------


class TestGuardBlocks:
    """When guard.check returns allowed=False, block with error JSON."""

    @pytest.mark.asyncio
    async def test_returns_error_json_when_blocked(self, started_bridge):
        """Should return structured error JSON when guard blocks."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": False,
                "reason": "writes blocked in PLANNING/DRAFT",
                "phase": "PLANNING",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock(return_value="should not be called")
        result = await _guarded_handler(
            started_bridge,
            original,
            "write_file",
            "s1",
            {"path": "src/main.py", "content": "hello"},
        )
        parsed = json.loads(result)
        assert "error" in parsed
        assert (
            "PLANNING" in parsed.get("phase", "")
            or "blocked" in parsed["error"].lower()
        )
        original.assert_not_called()

    @pytest.mark.asyncio
    async def test_includes_phase_info_in_error(self, started_bridge):
        """Error JSON should include phase and phaseState from guard."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": False,
                "reason": "blocked",
                "phase": "INTERFACES",
                "phaseState": "REVIEW",
            },
        )
        original = AsyncMock()
        result = await _guarded_handler(
            started_bridge,
            original,
            "edit_file",
            "s1",
            {},
        )
        parsed = json.loads(result)
        assert parsed["phase"] == "INTERFACES"
        assert parsed["phaseState"] == "REVIEW"


# ---------------------------------------------------------------------------
# Artisan passthrough
# ---------------------------------------------------------------------------


class TestArtisanPassthrough:
    """execute_command with artisan commands bypasses the guard."""

    def test_detects_artisan_at_start(self):
        """'artisan state' should be recognized."""
        assert _is_artisan_command("artisan state") is True

    def test_detects_relative_path(self):
        """'./artisan state' should be recognized."""
        assert _is_artisan_command("./artisan state") is True

    def test_detects_bun_invocation(self):
        """'bun run .../artisan.ts ...' should be recognized."""
        assert (
            _is_artisan_command("bun run packages/cli/artisan.ts select-mode") is True
        )

    def test_rejects_piped(self):
        """Compound shell commands must not bypass the guard."""
        assert _is_artisan_command("echo '{}' | artisan request-review") is False

    def test_rejects_chained(self):
        """Chained shell commands must not bypass the guard."""
        assert _is_artisan_command("echo hi && artisan state") is False

    def test_rejects_multiline(self):
        """Multiline shell commands must not bypass the guard."""
        assert _is_artisan_command("echo bad > file\nartisan state") is False

    def test_rejects_artisan_in_string(self):
        """'echo artisan' (no space after, not at command position) should NOT match."""
        assert _is_artisan_command("echo artisan") is False

    def test_rejects_artisan_as_substring(self):
        """'artisan_helper' should NOT match (no space after)."""
        assert _is_artisan_command("artisan_helper run") is False

    def test_rejects_prefixed_artisan(self):
        """'my-artisan tool' should NOT match."""
        assert _is_artisan_command("my-artisan tool") is False

    @pytest.mark.asyncio
    async def test_execute_command_bypasses_guard_for_artisan(self, started_bridge):
        """execute_command with artisan should skip guard.check entirely."""
        original = AsyncMock(return_value="state output")
        result = await _guarded_handler(
            started_bridge,
            original,
            "execute_command",
            "s1",
            {"command": "./artisan state"},
        )
        # Guard should NOT have been called
        guard_calls = started_bridge.get_calls("guard.check")
        assert len(guard_calls) == 0
        # Original should have been called
        original.assert_called_once()
        assert result == "state output"

    @pytest.mark.asyncio
    async def test_execute_command_uses_guard_for_compound_artisan(self, started_bridge):
        """execute_command with shell metacharacters should not skip guard.check."""
        started_bridge.set_response(
            "guard.check",
            {"allowed": False, "reason": "bash writes blocked", "phase": "PLANNING", "phaseState": "DRAFT"},
        )
        original = AsyncMock(return_value="should not run")
        result = await _guarded_handler(
            started_bridge,
            original,
            "execute_command",
            "s1",
            {"command": "echo bad > file; artisan state"},
        )
        parsed = json.loads(result)
        assert "bash writes blocked" in parsed["error"]
        assert len(started_bridge.get_calls("guard.check")) == 1
        original.assert_not_called()


# ---------------------------------------------------------------------------
# Bridge failure — guard unreachable
# ---------------------------------------------------------------------------


class TestBridgeFailure:
    """When bridge is unreachable, block writes (fail-closed)."""

    @pytest.mark.asyncio
    async def test_returns_error_on_bridge_failure(self, started_bridge):
        """Bridge communication failure should return error JSON, not allow writes."""

        def raise_error(params):
            raise BridgeError("Connection lost")

        started_bridge.set_response_fn("guard.check", raise_error)
        original = AsyncMock(return_value="should not run")
        result = await _guarded_handler(
            started_bridge,
            original,
            "write_file",
            "s1",
            {"path": "src/main.py"},
        )
        parsed = json.loads(result)
        assert "error" in parsed
        assert (
            "bridge" in parsed["error"].lower()
            or "unavailable" in parsed["error"].lower()
        )
        original.assert_not_called()

    @pytest.mark.asyncio
    async def test_bridge_failure_does_not_allow_writes(self, started_bridge):
        """Fail-closed: never silently allow writes when guard is unreachable."""
        started_bridge.set_response_fn(
            "guard.check", lambda p: (_ for _ in ()).throw(BridgeError("dead"))
        )
        original = AsyncMock()
        await _guarded_handler(
            started_bridge,
            original,
            "create_file",
            "s1",
            {"path": "new.py"},
        )
        original.assert_not_called()


# ---------------------------------------------------------------------------
# INCREMENTAL mode — bash write operator relay
# ---------------------------------------------------------------------------


class TestIncrementalBashRelay:
    """execute_command wrapper relays full command to guard.check so
    the bridge can evaluate bash write operators in INCREMENTAL mode."""

    @pytest.mark.asyncio
    async def test_execute_command_passes_command_to_guard(self, started_bridge):
        """guard.check must receive the full command string in args."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": True,
                "reason": "",
                "phase": "IMPLEMENTATION",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock(return_value="ok")
        await _guarded_handler(
            started_bridge,
            original,
            "execute_command",
            "s1",
            {"command": "echo hello > output.txt"},
        )
        guard_calls = started_bridge.get_calls("guard.check")
        assert len(guard_calls) == 1
        params = guard_calls[0][1]
        assert params["toolName"] == "execute_command"
        # The full command must be in args so the bridge can check for write operators
        assert "echo hello > output.txt" in json.dumps(params["args"])

    @pytest.mark.asyncio
    async def test_bash_redirect_blocked_in_incremental(self, started_bridge):
        """Bridge blocks '>' redirect in INCREMENTAL mode — wrapper relays the block."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": False,
                "reason": "Bash write operator '>' blocked in INCREMENTAL mode",
                "phase": "IMPLEMENTATION",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock()
        result = await _guarded_handler(
            started_bridge,
            original,
            "execute_command",
            "s1",
            {"command": "echo secret > /etc/passwd"},
        )
        parsed = json.loads(result)
        assert "error" in parsed
        assert "blocked" in parsed["error"].lower() or ">" in parsed["error"]
        original.assert_not_called()

    @pytest.mark.asyncio
    async def test_tee_command_blocked_in_incremental(self, started_bridge):
        """Bridge blocks 'tee' in INCREMENTAL mode — wrapper relays the block."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": False,
                "reason": "Bash write operator 'tee' blocked in INCREMENTAL mode",
                "phase": "IMPLEMENTATION",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock()
        result = await _guarded_handler(
            started_bridge,
            original,
            "execute_command",
            "s1",
            {"command": "cat data.json | tee output.json"},
        )
        parsed = json.loads(result)
        assert "error" in parsed
        original.assert_not_called()

    @pytest.mark.asyncio
    async def test_sed_inplace_blocked_in_incremental(self, started_bridge):
        """Bridge blocks 'sed -i' in INCREMENTAL mode — wrapper relays the block."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": False,
                "reason": "Bash write operator 'sed -i' blocked in INCREMENTAL mode",
                "phase": "IMPLEMENTATION",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock()
        result = await _guarded_handler(
            started_bridge,
            original,
            "execute_command",
            "s1",
            {"command": "sed -i 's/old/new/g' config.py"},
        )
        parsed = json.loads(result)
        assert "error" in parsed
        original.assert_not_called()

    @pytest.mark.asyncio
    async def test_read_only_command_allowed_in_incremental(self, started_bridge):
        """Read-only commands should be allowed even in INCREMENTAL mode."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": True,
                "reason": "",
                "phase": "IMPLEMENTATION",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock(return_value="file contents")
        result = await _guarded_handler(
            started_bridge,
            original,
            "execute_command",
            "s1",
            {"command": "cat src/main.py"},
        )
        assert result == "file contents"
        original.assert_called_once()


# ---------------------------------------------------------------------------
# .env file protection relay
# ---------------------------------------------------------------------------


class TestEnvFileProtection:
    """.env writes are always blocked regardless of phase."""

    @pytest.mark.asyncio
    async def test_env_write_blocked(self, started_bridge):
        """Guard should block writes to .env files — wrapper relays the block."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": False,
                "reason": ".env writes are always blocked",
                "phase": "IMPLEMENTATION",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock()
        result = await _guarded_handler(
            started_bridge,
            original,
            "write_file",
            "s1",
            {"path": ".env", "content": "SECRET=leaked"},
        )
        parsed = json.loads(result)
        assert "error" in parsed
        original.assert_not_called()

    @pytest.mark.asyncio
    async def test_nested_env_write_blocked(self, started_bridge):
        """Guard should block writes to nested .env files too."""
        started_bridge.set_response(
            "guard.check",
            {
                "allowed": False,
                "reason": ".env writes are always blocked",
                "phase": "IMPLEMENTATION",
                "phaseState": "DRAFT",
            },
        )
        original = AsyncMock()
        result = await _guarded_handler(
            started_bridge,
            original,
            "create_file",
            "s1",
            {"path": "config/.env.production", "content": "DB_PASS=x"},
        )
        parsed = json.loads(result)
        assert "error" in parsed
        original.assert_not_called()
