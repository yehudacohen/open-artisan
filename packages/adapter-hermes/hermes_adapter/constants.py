"""
constants.py — Schemas, toolset name, and bridge command for the Hermes adapter.
"""

from __future__ import annotations

import os
import re
import shlex
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


def resolve_reviewer_command(prompt: str) -> list[str]:
    """Resolve the isolated reviewer subprocess command.

    OPENARTISAN_REVIEWER_COMMAND may override the default command. Include the
    literal token {prompt} where the phase/task review prompt should be passed.
    If omitted, the prompt is appended as the final argument.
    """
    template = os.environ.get(
        "OPENARTISAN_REVIEWER_COMMAND",
        "claude --print --max-turns 1 -p {prompt}",
    )
    parts = shlex.split(template)
    if not parts:
        raise RuntimeError("OPENARTISAN_REVIEWER_COMMAND is empty")
    replaced = [prompt if part == "{prompt}" else part for part in parts]
    if "{prompt}" not in parts:
        replaced.append(prompt)
    return replaced


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
        "Submit self-review criteria assessment for the current artifact. In Hermes REVIEW state this is rejected because an isolated phase reviewer submits the verdict automatically.",
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
                "reason": {
                    "type": "string",
                    "description": "Why these task(s) are being reset, for drift repair provenance.",
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
                "artifact_files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Required list of file paths on disk that comprise the artifact.",
                },
                "artifact_markdown": {
                    "type": "string",
                    "description": "Optional markdown content for DISCOVERY/PLANNING/IMPL_PLAN; bridge materializes it to the canonical .openartisan artifact file before review.",
                },
            },
            "required": ["summary", "artifact_description", "artifact_files"],
        },
    ),
    (
        "oa_submit_feedback",
        "submit_feedback",
        "Approve or request revision at USER_GATE, or resolve explicit human gates at HUMAN_GATE.",
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
                "approved_files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional: file allowlist for INCREMENTAL mode PLANNING approval.",
                },
                "resolved_human_gates": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional: IMPLEMENTATION human-gated task IDs the user confirms are resolved.",
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
        "oa_analyze_task_boundary_change",
        "analyze_task_boundary_change",
        "Preview a localized implementation DAG task-boundary change.",
        {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "add_files": {"type": "array", "items": {"type": "string"}},
                "remove_files": {"type": "array", "items": {"type": "string"}},
                "add_expected_tests": {"type": "array", "items": {"type": "string"}},
                "remove_expected_tests": {"type": "array", "items": {"type": "string"}},
                "reason": {"type": "string"},
            },
            "required": ["task_id", "reason"],
        },
    ),
    (
        "oa_apply_task_boundary_change",
        "apply_task_boundary_change",
        "Apply an approved localized implementation DAG task-boundary change.",
        {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "add_files": {"type": "array", "items": {"type": "string"}},
                "remove_files": {"type": "array", "items": {"type": "string"}},
                "add_expected_tests": {"type": "array", "items": {"type": "string"}},
                "remove_expected_tests": {"type": "array", "items": {"type": "string"}},
                "expected_impacted_tasks": {"type": "array", "items": {"type": "string"}},
                "expected_reset_tasks": {"type": "array", "items": {"type": "string"}},
                "reason": {"type": "string"},
            },
            "required": ["task_id", "reason"],
        },
    ),
    (
        "oa_route_patch_suggestions",
        "route_patch_suggestions",
        "Classify pending reviewer patch suggestions for apply/defer/backtrack/user routing.",
        {"type": "object", "properties": {}},
    ),
    (
        "oa_resolve_patch_suggestion",
        "resolve_patch_suggestion",
        "Record a persisted reviewer patch suggestion disposition.",
        {
            "type": "object",
            "properties": {
                "patch_suggestion_id": {"type": "string"},
                "resolution": {
                    "type": "string",
                    "enum": ["applied", "failed", "deferred", "rejected", "escalated"],
                },
                "message": {"type": "string"},
                "applied_by": {"type": "string", "enum": ["agent", "orchestrator", "user"]},
            },
            "required": ["patch_suggestion_id", "resolution"],
        },
    ),
    (
        "oa_apply_patch_suggestion",
        "apply_patch_suggestion",
        "Apply a pending reviewer patch suggestion to the worktree and record the result.",
        {
            "type": "object",
            "properties": {
                "patch_suggestion_id": {"type": "string"},
                "force": {"type": "boolean"},
                "applied_by": {"type": "string", "enum": ["agent", "orchestrator", "user"]},
            },
            "required": ["patch_suggestion_id"],
        },
    ),
    (
        "oa_report_drift",
        "report_drift",
        "Report workflow drift using artifact, task, worktree, DB, and changed-file signals.",
        {
            "type": "object",
            "properties": {
                "scope": {"type": "string", "enum": ["current-task", "current-phase", "workflow", "roadmap"]},
                "include_worktree": {"type": "boolean"},
                "include_artifacts": {"type": "boolean"},
                "include_db": {"type": "boolean"},
                "changed_files": {"type": "array", "items": {"type": "string"}},
                "drifted_artifact_keys": {"type": "array", "items": {"type": "string", "enum": ["design", "conventions", "plan", "interfaces", "tests", "impl_plan", "implementation"]}},
                "task_ids": {"type": "array", "items": {"type": "string"}},
            },
        },
    ),
    (
        "oa_plan_drift_repair",
        "plan_drift_repair",
        "Build a graph-native repair plan for a reported drift report.",
        {
            "type": "object",
            "properties": {
                "drift_report_id": {"type": "string"},
                "strategy": {"type": "string", "enum": ["minimal", "safe-auto", "ask-first"]},
            },
        },
    ),
    (
        "oa_apply_drift_repair",
        "apply_drift_repair",
        "Apply approved drift repair actions through existing workflow tools.",
        {
            "type": "object",
            "properties": {
                "repair_plan_id": {"type": "string"},
                "approved_actions": {"type": "array", "items": {"type": "string"}},
                "apply_safe_actions": {"type": "boolean"},
            },
            "required": ["repair_plan_id"],
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
