"""
test_setup.py — Tests for the Hermes adapter setup script (__main__.py).

Verifies directory creation, template generation, bridge validation,
and idempotency.
"""
from __future__ import annotations

import json
import pytest
from pathlib import Path
from unittest.mock import patch

from hermes_adapter.__main__ import setup, _generate_hermes_template


# ---------------------------------------------------------------------------
# Template generation
# ---------------------------------------------------------------------------


class TestGenerateTemplate:
    """_generate_hermes_template reads from .hermes.md.tmpl."""

    def test_returns_non_empty_string(self):
        """Template should always return a non-empty string."""
        result = _generate_hermes_template()
        assert isinstance(result, str)
        assert len(result) > 0

    def test_contains_workflow_phases(self):
        """Template should mention the 8 workflow phases."""
        result = _generate_hermes_template()
        assert "MODE_SELECT" in result
        assert "IMPLEMENTATION" in result
        assert "USER_GATE" in result

    def test_contains_tool_names(self):
        """Template should list oa_ prefixed tools."""
        result = _generate_hermes_template()
        assert "oa_select_mode" in result
        assert "oa_request_review" in result
        assert "oa_mark_satisfied" in result

    def test_fallback_when_template_missing(self):
        """If .hermes.md.tmpl is not found, return minimal fallback."""
        with patch("hermes_adapter.__main__.Path") as mock_path:
            mock_path.return_value.resolve.return_value.parent.parent.__truediv__ = lambda self, x: Path("/nonexistent/.hermes.md.tmpl")
            # The function should not crash
            result = _generate_hermes_template()
            assert isinstance(result, str)


# ---------------------------------------------------------------------------
# Setup function
# ---------------------------------------------------------------------------


class TestSetup:
    """setup() creates .openartisan/ and .hermes.md."""

    def test_creates_state_directory(self, tmp_path):
        """Should create .openartisan/ directory."""
        setup(str(tmp_path))
        assert (tmp_path / ".openartisan").is_dir()

    def test_creates_hermes_md(self, tmp_path):
        """Should create .hermes.md with workflow instructions."""
        setup(str(tmp_path))
        hermes_md = tmp_path / ".hermes.md"
        assert hermes_md.is_file()
        content = hermes_md.read_text()
        assert "MODE_SELECT" in content

    def test_idempotent_state_dir(self, tmp_path):
        """Running setup twice should not fail or overwrite."""
        setup(str(tmp_path))
        setup(str(tmp_path))  # second run
        assert (tmp_path / ".openartisan").is_dir()

    def test_skips_existing_hermes_md(self, tmp_path):
        """If .hermes.md exists, should not overwrite."""
        hermes_md = tmp_path / ".hermes.md"
        hermes_md.write_text("custom content")
        setup(str(tmp_path))
        assert hermes_md.read_text() == "custom content"

    def test_exits_on_missing_project_dir(self):
        """Should exit with error for non-existent project dir."""
        with pytest.raises(SystemExit):
            setup("/nonexistent/path/that/does/not/exist")

    def test_validates_bridge_cli(self, tmp_path):
        """Should attempt to validate bridge CLI without crashing."""
        # resolve_bridge_command may or may not find the bridge —
        # setup should handle both gracefully
        setup(str(tmp_path))
        # If we get here, no crash occurred


# ---------------------------------------------------------------------------
# Auto-approval dispatch
# ---------------------------------------------------------------------------


class TestAutoApprovalDispatch:
    """Tests for _dispatch_auto_approve in prompt_hook.py."""

    def test_calls_message_process_before_approve(self, started_bridge):
        """Should call message.process before dispatching auto-approval."""
        from hermes_adapter.prompt_hook import _dispatch_auto_approve

        started_bridge.set_response("message.process", None)
        started_bridge.set_response("task.getAutoApproveContext", None)  # skip dispatch

        _dispatch_auto_approve(started_bridge, "s1", "/tmp/project")

        msg_calls = started_bridge.get_calls("message.process")
        assert len(msg_calls) == 1
        assert msg_calls[0][1]["sessionId"] == "s1"

    def test_skips_when_no_approve_context(self, started_bridge):
        """Should skip dispatch when getAutoApproveContext returns None."""
        from hermes_adapter.prompt_hook import _dispatch_auto_approve

        started_bridge.set_response("message.process", None)
        started_bridge.set_response("task.getAutoApproveContext", None)

        _dispatch_auto_approve(started_bridge, "s1", "/tmp/project")

        # Should NOT have called tool.execute
        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 0

    def test_dispatches_subprocess_on_valid_context(self, started_bridge):
        """Should spawn subprocess and submit results when context available."""
        from hermes_adapter.prompt_hook import _dispatch_auto_approve
        from unittest.mock import MagicMock

        started_bridge.set_response("message.process", None)
        started_bridge.set_response("task.getAutoApproveContext", "Review this artifact...")
        started_bridge.set_response("tool.execute", "ok")

        mock_result = MagicMock()
        mock_result.stdout = json.dumps({
            "approve": True, "confidence": 0.9, "reasoning": "Looks good"
        })

        with patch("hermes_adapter.prompt_hook.subprocess.run", return_value=mock_result):
            _dispatch_auto_approve(started_bridge, "s1", "/tmp/project")

        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 1
        assert tool_calls[0][1]["name"] == "submit_auto_approve"

    def test_handles_subprocess_failure_gracefully(self, started_bridge):
        """Should not crash if subprocess fails."""
        from hermes_adapter.prompt_hook import _dispatch_auto_approve
        import subprocess

        started_bridge.set_response("message.process", None)
        started_bridge.set_response("task.getAutoApproveContext", "Review prompt")

        with patch("hermes_adapter.prompt_hook.subprocess.run",
                   side_effect=FileNotFoundError("claude not found")):
            _dispatch_auto_approve(started_bridge, "s1", "/tmp/project")

        # Should not have called tool.execute (subprocess failed)
        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 0

    def test_handles_timeout_gracefully(self, started_bridge):
        """Should not crash if subprocess times out."""
        from hermes_adapter.prompt_hook import _dispatch_auto_approve
        import subprocess as sp

        started_bridge.set_response("message.process", None)
        started_bridge.set_response("task.getAutoApproveContext", "Review prompt")

        with patch("hermes_adapter.prompt_hook.subprocess.run",
                   side_effect=sp.TimeoutExpired("claude", 120)):
            _dispatch_auto_approve(started_bridge, "s1", "/tmp/project")

        tool_calls = started_bridge.get_calls("tool.execute")
        assert len(tool_calls) == 0
