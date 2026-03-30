"""
__main__.py — Setup script for the Hermes adapter.

Usage:
    python -m hermes_adapter --project-dir /path/to/project

Creates:
    .openartisan/               State directory
    .hermes.md                  Project-level workflow instructions (from template)

Equivalent to Claude Code's artisan-setup.ts.
"""
from __future__ import annotations

import argparse
import logging
import os
import shutil
import sys
from pathlib import Path

from .constants import DEFAULT_STATE_DIR_NAME, resolve_bridge_command

logger = logging.getLogger(__name__)

TEMPLATE_NAME = ".hermes.md.tmpl"
OUTPUT_NAME = ".hermes.md"


def setup(project_dir: str) -> None:
    """Set up a project for the open-artisan Hermes workflow.

    1. Creates .openartisan/ state directory
    2. Copies .hermes.md.tmpl → .hermes.md (project workflow instructions)
    3. Validates bridge CLI is reachable
    """
    project = Path(project_dir).resolve()
    if not project.is_dir():
        print(f"Error: project directory does not exist: {project}", file=sys.stderr)
        sys.exit(1)

    # 1. Create state directory
    state_dir = project / DEFAULT_STATE_DIR_NAME
    state_dir.mkdir(parents=True, exist_ok=True)
    print(f"  Created {state_dir}/")

    # 2. Copy template → .hermes.md
    template_path = Path(__file__).resolve().parent.parent / TEMPLATE_NAME
    output_path = project / OUTPUT_NAME

    if output_path.exists():
        print(f"  {OUTPUT_NAME} already exists — skipping (delete to regenerate)")
    elif template_path.is_file():
        shutil.copy2(template_path, output_path)
        print(f"  Created {OUTPUT_NAME} (workflow instructions)")
    else:
        print(f"  Warning: template not found at {template_path}", file=sys.stderr)
        print(f"  You'll need to create {OUTPUT_NAME} manually.", file=sys.stderr)

    # 3. Validate bridge CLI
    try:
        cmd = resolve_bridge_command()
        print(f"  Bridge CLI: {' '.join(cmd)}")
    except RuntimeError as e:
        print(f"  Warning: {e}", file=sys.stderr)
        print(f"  Set OPENARTISAN_BRIDGE_CLI=/path/to/packages/bridge/cli.ts", file=sys.stderr)

    # 4. Summary
    print()
    print("Setup complete. To start the workflow:")
    print(f"  1. Ensure Hermes loads the open-artisan plugin")
    print(f"  2. Start a Hermes session in {project}")
    print(f"  3. The workflow begins at MODE_SELECT — call oa_select_mode to start")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m hermes_adapter",
        description="Set up a project for the open-artisan Hermes workflow",
    )
    parser.add_argument(
        "--project-dir",
        required=True,
        help="Path to the project directory",
    )
    args = parser.parse_args()
    setup(args.project_dir)


if __name__ == "__main__":
    main()
