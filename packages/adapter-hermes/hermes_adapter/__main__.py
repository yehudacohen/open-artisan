"""
__main__.py — Setup script for the Hermes adapter.

Usage:
    python -m hermes_adapter --project-dir /path/to/project

Creates:
    .openartisan/               State directory
    .hermes.md                  Project-level workflow instructions (generated)

Equivalent to Claude Code's artisan-setup.ts.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .constants import DEFAULT_STATE_DIR_NAME, resolve_bridge_command

logger = logging.getLogger(__name__)

OUTPUT_NAME = ".hermes.md"


def _generate_hermes_template() -> str:
    """Generate .hermes.md content from the centralized template.

    Falls back to reading .hermes.md.tmpl if the core generator is
    not available (e.g. when installed via pip without the monorepo).
    """
    # Try the centralized generator first (monorepo / editable install)
    try:
        # The generator is in the TypeScript core — we can't import it directly.
        # Read the .hermes.md.tmpl as the generated source of truth.
        template_path = Path(__file__).resolve().parent.parent / ".hermes.md.tmpl"
        if template_path.is_file():
            return template_path.read_text("utf-8")
    except Exception:
        pass

    # Minimal fallback if template is missing
    return (
        "# Open Artisan — Workflow Instructions\n\n"
        "This project uses the Open Artisan phased workflow.\n"
        "See https://github.com/open-artisan/open-artisan for documentation.\n"
    )


def setup(project_dir: str) -> None:
    """Set up a project for the open-artisan Hermes workflow.

    1. Creates .openartisan/ state directory
    2. Generates .hermes.md (project workflow instructions)
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

    # 2. Generate .hermes.md
    output_path = project / OUTPUT_NAME
    if output_path.exists():
        print(f"  {OUTPUT_NAME} already exists — skipping (delete to regenerate)")
    else:
        content = _generate_hermes_template()
        output_path.write_text(content, "utf-8")
        print(f"  Created {OUTPUT_NAME} (workflow instructions)")

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
    print("  1. Ensure Hermes loads the open-artisan plugin")
    print(f"  2. Start a Hermes session in {project}")
    print("  3. The workflow begins at MODE_SELECT — call oa_select_mode to start")
    print()
    print("Robot-artisan (automated mode):")
    print("  Pass agent='robot-artisan' in lifecycle.sessionCreated to enable")
    print("  auto-approval at USER_GATE (requires claude CLI for subprocess).")


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
