"""
constants.py — Schemas, toolset name, and bridge command for the Hermes adapter.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# Bridge subprocess command resolution
# ---------------------------------------------------------------------------


def resolve_bridge_command() -> list[str]:
    """Resolve the bridge CLI command.

    Resolution order:
    1. OPENARTISAN_BRIDGE_CLI env var (explicit override)
    2. Relative to this package (monorepo / editable pip install)
    3. Error with instructions
    """
    # 1. Explicit env var — always wins
    env_cli = os.environ.get("OPENARTISAN_BRIDGE_CLI")
    if env_cli:
        return ["bun", "run", env_cli]

    # 2. Relative to this package (monorepo / editable pip install)
    pkg_relative = Path(__file__).resolve().parent.parent.parent / "bridge" / "cli.ts"
    if pkg_relative.is_file():
        return ["bun", "run", str(pkg_relative)]

    raise RuntimeError(
        "Cannot find bridge CLI. Set OPENARTISAN_BRIDGE_CLI=/path/to/packages/bridge/cli.ts "
        "or install open-artisan in the monorepo."
    )


# ---------------------------------------------------------------------------
# Toolset name — groups all open-artisan tools in Hermes
# ---------------------------------------------------------------------------

TOOLSET_NAME = "open-artisan"

# ---------------------------------------------------------------------------
# Default state directory name
# ---------------------------------------------------------------------------

DEFAULT_STATE_DIR_NAME = ".openartisan"
DEFAULT_SOCKET_FILENAME = ".bridge.sock"
BRIDGE_METADATA_FILENAME = ".bridge-meta.json"
BRIDGE_LEASES_FILENAME = ".bridge-clients.json"

# ---------------------------------------------------------------------------
# Capabilities (agent-only mode — no SubagentDispatcher)
# ---------------------------------------------------------------------------

DEFAULT_CAPABILITIES: dict = {
    "selfReview": "agent-only",
    "orchestrator": False,
    "discoveryFleet": False,
}

# ---------------------------------------------------------------------------
# Workflow tool definitions
#
# Each entry: (hermes_tool_name, bridge_tool_name, description, parameter_schema)
# These are registered via ctx.register() in workflow_tools.py.
# ---------------------------------------------------------------------------

WORKFLOW_TOOLS: list[tuple[str, str, str, dict]] = [
    (
        "oa_select_mode",
        "select_mode",
        "Select the workflow mode (GREENFIELD, REFACTOR, or INCREMENTAL) and set the feature name.",
        {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["GREENFIELD", "REFACTOR", "INCREMENTAL"],
                    "description": "Workflow mode.",
                },
                "feature_name": {
                    "type": "string",
                    "description": "Short identifier for this feature (alphanumeric, hyphens, underscores).",
                },
            },
            "required": ["mode", "feature_name"],
        },
    ),
    (
        "oa_mark_scan_complete",
        "mark_scan_complete",
        "Mark the discovery scan phase as complete.",
        {
            "type": "object",
            "properties": {
                "scan_summary": {
                    "type": "string",
                    "description": "Summary of what the scan found.",
                },
            },
            "required": ["scan_summary"],
        },
    ),
    (
        "oa_mark_analyze_complete",
        "mark_analyze_complete",
        "Mark the discovery analysis phase as complete.",
        {
            "type": "object",
            "properties": {
                "analysis_summary": {
                    "type": "string",
                    "description": "Summary of conventions and architecture discovered.",
                },
            },
            "required": ["analysis_summary"],
        },
    ),
    (
        "oa_mark_satisfied",
        "mark_satisfied",
        "Submit self-review criteria assessment for the current artifact.",
        {
            "type": "object",
            "properties": {
                "criteria_met": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "criterion": {"type": "string"},
                            "met": {"type": "boolean"},
                            "evidence": {"type": "string"},
                            "severity": {
                                "type": "string",
                                "enum": ["blocking", "suggestion"],
                            },
                        },
                        "required": ["criterion", "met", "evidence"],
                    },
                    "description": "Array of criteria assessments.",
                },
            },
            "required": ["criteria_met"],
        },
    ),
    (
        "oa_mark_task_complete",
        "mark_task_complete",
        "Mark the current implementation DAG task as complete.",
        {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "The task ID (e.g. T1)."},
                "implementation_summary": {
                    "type": "string",
                    "description": "What was implemented.",
                },
                "tests_passing": {
                    "type": "boolean",
                    "description": "Whether all tests pass.",
                },
            },
            "required": ["task_id", "implementation_summary", "tests_passing"],
        },
    ),
    (
        "oa_submit_task_review",
        "submit_task_review",
        "Submit the per-task review result for the currently pending implementation task review.",
        {
            "type": "object",
            "properties": {
                "review_output": {
                    "type": "string",
                    "description": "Raw review output from the isolated per-task reviewer.",
                },
            },
            "required": ["review_output"],
        },
    ),
    (
        "oa_reset_task",
        "reset_task",
        "Reset one or more implementation DAG tasks back to pending by task ID.",
        {
            "type": "object",
            "properties": {
                "task_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": 'Task IDs to reset (for example: ["T3"]).',
                },
            },
            "required": ["task_ids"],
        },
    ),
    (
        "oa_request_review",
        "request_review",
        "Submit the current artifact for review.",
        {
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "Brief summary of the artifact.",
                },
                "artifact_description": {
                    "type": "string",
                    "description": "Description of what was produced.",
                },
                "artifact_content": {
                    "type": "string",
                    "description": "Text content of the artifact (for text-based phases like PLANNING).",
                },
                "artifact_files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of file paths that comprise the artifact (for INTERFACES, TESTS).",
                },
            },
            "required": ["summary", "artifact_description"],
        },
    ),
    (
        "oa_submit_feedback",
        "submit_feedback",
        "Approve or request revision of the current artifact at USER_GATE.",
        {
            "type": "object",
            "properties": {
                "feedback_type": {
                    "type": "string",
                    "enum": ["approve", "revise"],
                    "description": "Approve the artifact or request revisions.",
                },
                "feedback_text": {
                    "type": "string",
                    "description": "Feedback details (required for 'revise').",
                },
                "artifact_content": {
                    "type": "string",
                    "description": "Optional: artifact content to persist on approve.",
                },
                "approved_files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional: file allowlist for INCREMENTAL mode PLANNING approval.",
                },
            },
            "required": ["feedback_type"],
        },
    ),
    (
        "oa_check_prior_workflow",
        "check_prior_workflow",
        "Check if a prior workflow exists for a feature name.",
        {
            "type": "object",
            "properties": {
                "feature_name": {
                    "type": "string",
                    "description": "Feature name to check.",
                },
            },
            "required": ["feature_name"],
        },
    ),
    (
        "oa_resolve_human_gate",
        "resolve_human_gate",
        "Set a human gate on a DAG task that requires manual action.",
        {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "what_is_needed": {"type": "string"},
                "why": {"type": "string"},
                "verification_steps": {"type": "string"},
            },
            "required": ["task_id", "what_is_needed"],
        },
    ),
    (
        "oa_propose_backtrack",
        "propose_backtrack",
        "Propose going back to an earlier workflow phase.",
        {
            "type": "object",
            "properties": {
                "target_phase": {
                    "type": "string",
                    "description": "Phase to backtrack to (e.g. PLANNING).",
                },
                "reason": {
                    "type": "string",
                    "description": "Why backtracking is necessary.",
                },
            },
            "required": ["target_phase", "reason"],
        },
    ),
    (
        "oa_spawn_sub_workflow",
        "spawn_sub_workflow",
        "Delegate a DAG task to a child sub-workflow.",
        {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "feature_name": {"type": "string"},
            },
            "required": ["task_id", "feature_name"],
        },
    ),
    (
        "oa_query_parent_workflow",
        "query_parent_workflow",
        "Read-only inspection of the parent workflow state.",
        {"type": "object", "properties": {}},
    ),
    (
        "oa_query_child_workflow",
        "query_child_workflow",
        "Read-only inspection of a child workflow state.",
        {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "Task ID of the delegated task.",
                },
            },
            "required": ["task_id"],
        },
    ),
]

# oa_state is a special tool — calls state.get directly, not tool.execute
OA_STATE_SCHEMA: dict = {
    "type": "object",
    "properties": {},
    "description": "Show the current workflow state (phase, mode, task, approved artifacts).",
}

# ---------------------------------------------------------------------------
# Guarded built-in tools — these get wrapper enforcement
# ---------------------------------------------------------------------------

GUARDED_TOOLS: list[str] = [
    "write_file",
    "edit_file",
    "create_file",
    "patch_file",
    "execute_command",
]

# Regex to detect artisan commands — bypass bash guard for execute_command
ARTISAN_COMMAND_RE = re.compile(
    r"(?:^|[|;&]\s*)(?:(?:bun\s+run\s+\S*(?:artisan(?:\.ts)?)?)|\.\/artisan|artisan)\s",
    re.MULTILINE,
)
