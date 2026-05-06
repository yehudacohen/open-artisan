"""
constants.py — Runtime constants and generated tool contracts for Hermes.
"""

from __future__ import annotations

import json
import os
import re
import shlex
from pathlib import Path
from typing import Any


def resolve_bridge_command() -> list[str]:
    """Resolve the bridge CLI command."""
    env_cli = os.environ.get("OPENARTISAN_BRIDGE_CLI")
    if env_cli:
        return ["bun", "run", env_cli]

    pkg_relative = Path(__file__).resolve().parent.parent.parent / "bridge" / "cli.ts"
    if pkg_relative.is_file():
        return ["bun", "run", str(pkg_relative)]

    raise RuntimeError(
        "Cannot find bridge CLI. Set OPENARTISAN_BRIDGE_CLI=/path/to/packages/bridge/cli.ts "
        "or install open-artisan in the monorepo."
    )


def resolve_reviewer_command(prompt: str) -> list[str]:
    """Resolve the isolated reviewer subprocess command."""
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


TOOLSET_NAME = "open-artisan"

DEFAULT_STATE_DIR_NAME = ".openartisan"
DEFAULT_SOCKET_FILENAME = ".bridge.sock"
BRIDGE_METADATA_FILENAME = ".bridge-meta.json"
BRIDGE_LEASES_FILENAME = ".bridge-clients.json"

DEFAULT_CAPABILITIES: dict = {
    "selfReview": "agent-only",
    "orchestrator": False,
    "discoveryFleet": False,
}


def _load_workflow_tools() -> list[tuple[str, str, str, dict[str, Any]]]:
    contracts_path = Path(__file__).with_name("tool_contracts.json")
    contracts = json.loads(contracts_path.read_text(encoding="utf-8"))
    return [
        (
            str(contract["hermes_name"]),
            str(contract["bridge_name"]),
            str(contract["description"]),
            dict(contract["schema"]),
        )
        for contract in contracts
        if contract["bridge_name"] != "_state_get"
    ]


# Generated from packages/core/tool-contracts.ts via packages/core/schemas.ts.
WORKFLOW_TOOLS = _load_workflow_tools()

# oa_state is a special tool — calls state.get directly, not tool.execute.
OA_STATE_SCHEMA: dict = {
    "type": "object",
    "properties": {},
    "additionalProperties": False,
    "description": "Show the current workflow state (phase, mode, task, approved artifacts).",
}

GUARDED_TOOLS: list[str] = [
    "write_file",
    "edit_file",
    "create_file",
    "patch_file",
    "execute_command",
]

# Regex to detect artisan commands — bypass bash guard for execute_command.
ARTISAN_COMMAND_RE = re.compile(
    r"(?:^|[|;&]\s*)(?:(?:bun\s+run\s+\S*(?:artisan(?:\.ts)?)?)|\.\/artisan|artisan)\s",
    re.MULTILINE,
)
