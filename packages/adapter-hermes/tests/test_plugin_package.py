from __future__ import annotations

from pathlib import Path


def test_plugin_root_init_exists_for_hermes_loader() -> None:
    plugin_root = Path(__file__).parents[1]
    init_file = plugin_root / "__init__.py"

    assert init_file.is_file()
    assert "register" in init_file.read_text()
