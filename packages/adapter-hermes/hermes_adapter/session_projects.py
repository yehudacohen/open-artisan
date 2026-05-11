"""Session-local Open Artisan project selection for Hermes gateway sessions."""

from __future__ import annotations

import os
from pathlib import Path
from threading import Lock
from typing import Any

_SESSION_PROJECT_DIRS: dict[str, str] = {}
_EXPLICIT_PROJECT_SESSION_IDS: set[str] = set()
_LAST_USER_MESSAGES: dict[str, str] = {}
_LAST_SESSION_CONTEXTS: dict[str, dict[str, Any]] = {}
_ACTIVE_SESSION_ID: str | None = None
_LOCK = Lock()
_DEFAULT_SCAN_LIMIT = 20
_MAX_SCAN_DEPTH = 4
_PROJECT_DIR_ENV_NAMES = ("OPENARTISAN_PROJECT_DIR", "OPENARTISAN_DEFAULT_PROJECT_DIR")


def normalize_project_dir(project_dir: str) -> str:
    return str(Path(project_dir).expanduser().resolve())


def set_session_project_dir(session_id: str, project_dir: str, *, explicit: bool = False) -> str:
    normalized = normalize_project_dir(project_dir)
    with _LOCK:
        _SESSION_PROJECT_DIRS[session_id] = normalized
        if explicit:
            _EXPLICIT_PROJECT_SESSION_IDS.add(session_id)
    return normalized


def get_session_project_dir(session_id: str | None) -> str | None:
    if not session_id:
        return None
    with _LOCK:
        return _SESSION_PROJECT_DIRS.get(session_id)


def clear_session_project_dir(session_id: str | None) -> None:
    if not session_id:
        return
    with _LOCK:
        _SESSION_PROJECT_DIRS.pop(session_id, None)
        _EXPLICIT_PROJECT_SESSION_IDS.discard(session_id)
        _LAST_USER_MESSAGES.pop(session_id, None)
        _LAST_SESSION_CONTEXTS.pop(session_id, None)


def has_explicit_session_project(session_id: str | None) -> bool:
    if not session_id:
        return False
    with _LOCK:
        return session_id in _EXPLICIT_PROJECT_SESSION_IDS


def set_active_session_id(session_id: str | None) -> None:
    if not session_id:
        return
    with _LOCK:
        global _ACTIVE_SESSION_ID
        _ACTIVE_SESSION_ID = session_id


def get_active_session_id() -> str | None:
    with _LOCK:
        return _ACTIVE_SESSION_ID


def clear_active_session_id(session_id: str | None) -> None:
    if not session_id:
        return
    with _LOCK:
        global _ACTIVE_SESSION_ID
        if _ACTIVE_SESSION_ID == session_id:
            _ACTIVE_SESSION_ID = None


def set_last_user_message(session_id: str | None, message: str | None) -> None:
    if not session_id or not message or not message.strip():
        return
    with _LOCK:
        _LAST_USER_MESSAGES[session_id] = message.strip()


def get_last_user_message(session_id: str | None) -> str | None:
    if not session_id:
        return None
    with _LOCK:
        return _LAST_USER_MESSAGES.get(session_id)


def set_last_session_context(session_id: str | None, context: dict[str, Any] | None) -> None:
    if not session_id or not context:
        return
    cleaned = {key: value for key, value in context.items() if isinstance(value, str) and value.strip()}
    if not cleaned:
        return
    with _LOCK:
        _LAST_SESSION_CONTEXTS[session_id] = cleaned


def get_last_session_context(session_id: str | None) -> dict[str, Any] | None:
    if not session_id:
        return None
    with _LOCK:
        stored = _LAST_SESSION_CONTEXTS.get(session_id)
        return dict(stored) if stored else None


def get_configured_project_dir() -> str | None:
    for name in _PROJECT_DIR_ENV_NAMES:
        value = os.environ.get(name)
        if not value or not value.strip():
            continue
        normalized = normalize_project_dir(value)
        if is_openartisan_project(normalized):
            return normalized
    return None


def resolve_project_dir(session_id: str | None, fallback: str | None = None) -> str:
    selected = get_session_project_dir(session_id)
    if selected:
        return selected
    configured = get_configured_project_dir()
    if configured:
        return configured
    if fallback:
        return normalize_project_dir(fallback)
    return normalize_project_dir(os.getcwd())


def is_openartisan_project(project_dir: str) -> bool:
    return Path(project_dir, ".openartisan").is_dir()


def discover_openartisan_projects(limit: int = _DEFAULT_SCAN_LIMIT) -> list[dict[str, Any]]:
    roots: list[Path] = []
    cwd = Path.cwd()
    roots.append(cwd)
    home_workspace = Path.home() / "workspace"
    if home_workspace.is_dir() and home_workspace not in roots:
        roots.append(home_workspace)

    discovered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for root in roots:
        discovered.extend(_discover_under_root(root, seen, limit))
        if len(discovered) >= limit:
            break
    return discovered[:limit]


def _discover_under_root(root: Path, seen: set[str], limit: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    root = root.resolve()
    for current, dirnames, _filenames in os.walk(root):
        current_path = Path(current)
        depth = len(current_path.relative_to(root).parts)
        if depth > _MAX_SCAN_DEPTH:
            dirnames[:] = []
            continue

        if ".git" in dirnames:
            dirnames.remove(".git")

        if ".openartisan" in dirnames:
            project_dir = str(current_path)
            if project_dir not in seen:
                seen.add(project_dir)
                results.append(_build_project_info(current_path))
                if len(results) >= limit:
                    break
            dirnames[:] = [d for d in dirnames if d != ".openartisan"]
    return results


def _build_project_info(project_dir: Path) -> dict[str, Any]:
    state_dir = project_dir / ".openartisan"
    features: list[str] = []
    if state_dir.is_dir():
        for child in state_dir.iterdir():
            if child.is_dir() and (child / "workflow-state.json").is_file():
                features.append(child.name)
    features.sort()
    return {
        "projectDir": str(project_dir),
        "featureNames": features,
        "workflowCount": len(features),
    }
