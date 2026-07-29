"""Locating what the wheel bundles: the built UI and the probe udev rules.

Both live under ``boardex_app/_bundled/``, put there by the build hook. They are
read through ``importlib.resources`` so an installed wheel is the source of
truth — no repo checkout, no Node, no path guessing.

The UI is handed to the runner as a directory PATH (it serves files off disk),
so a zip-imported install is out of scope; the fallback below keeps working for
the ordinary directory install and for a source checkout whose bundle the build
hook has already populated.
"""

from __future__ import annotations

from importlib import resources
from pathlib import Path

BUNDLE_PACKAGE = "boardex_app"
BUNDLE_NAME = "_bundled"


def bundled_dir() -> Path:
    """The ``_bundled`` directory inside the installed package."""
    try:
        return Path(str(resources.files(BUNDLE_PACKAGE))) / BUNDLE_NAME
    except (ModuleNotFoundError, TypeError):  # pragma: no cover - defensive
        return Path(__file__).resolve().parent / BUNDLE_NAME


def ui_bundle_dir() -> Path | None:
    """The embedded UI bundle, or None when this install has no UI in it."""
    ui = bundled_dir() / "ui"
    return ui if (ui / "index.html").is_file() else None


def contract_schema_dir() -> Path | None:
    """The bundled copy of ``packages/contract/json-schema``, or None.

    The runner validates every outbound event against these and locates them by
    walking up for a repo checkout — which an installed wheel does not sit in.
    ``boardex up`` hands this path over through the runner's own
    ``BOARDEX_CONTRACT_SCHEMA_DIR``.
    """
    schemas = bundled_dir() / "contract-schema"
    return schemas if (schemas / "events.schema.json").is_file() else None


def udev_rules_path() -> Path | None:
    """The bundled probe udev rules file (Linux fix line), or None."""
    rules = bundled_dir() / "udev" / "49-boardex-probes.rules"
    return rules if rules.is_file() else None
