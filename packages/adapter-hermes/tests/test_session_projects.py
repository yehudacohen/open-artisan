from __future__ import annotations

from pathlib import Path

from hermes_adapter.session_projects import (
    clear_session_project_dir,
    discover_openartisan_projects,
    get_session_project_dir,
    resolve_project_dir,
    set_session_project_dir,
)


def test_session_project_override_round_trip(tmp_path: Path) -> None:
    project = tmp_path / "repo"
    project.mkdir()

    selected = set_session_project_dir("s1", str(project))

    assert get_session_project_dir("s1") == selected
    assert resolve_project_dir("s1", "/fallback") == selected

    clear_session_project_dir("s1")
    assert get_session_project_dir("s1") is None


def test_discover_openartisan_projects_finds_workspace_projects(
    tmp_path: Path, monkeypatch
) -> None:
    workspace = tmp_path / "workspace"
    repo = workspace / "open-artisan"
    feature = repo / ".openartisan" / "feature-a"
    feature.mkdir(parents=True)
    (feature / "workflow-state.json").write_text("{}")

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    projects = discover_openartisan_projects()

    assert any(project["projectDir"] == str(repo) for project in projects)
    match = next(project for project in projects if project["projectDir"] == str(repo))
    assert match["featureNames"] == ["feature-a"]
