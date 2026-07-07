"""Registry of peripheral inspectors available to ``inspect_peripheral``.

Inspectors are keyed by *silicon family* + *peripheral name*, so ``I2C1`` on
an STM32 and ``I2C1`` on some future NXP part coexist. Agents may address a
peripheral by bare name (resolved when unambiguous) or family-qualified as
``"family:NAME"`` (e.g. ``"stm32:I2C1"``).

New families plug in two ways:
- in-tree: add a module under ``peripherals/`` and call ``register(...)``;
- third-party: publish a ``boardex.peripheral_inspectors`` entry point whose
  callable returns an iterable of inspectors — no Boardex code changes.
"""

from __future__ import annotations

import logging
from collections import Counter
from importlib.metadata import entry_points

from .base import PeripheralInspector

log = logging.getLogger(__name__)

PLUGIN_GROUP = "boardex.peripheral_inspectors"

_INSPECTORS: dict[tuple[str, str], PeripheralInspector] = {}


def _key(family: str, name: str) -> tuple[str, str]:
    return (family.strip().lower(), name.strip().upper())


def register(inspector: PeripheralInspector) -> None:
    _INSPECTORS[_key(inspector.family, inspector.name)] = inspector


def get(name: str, family: str | None = None) -> PeripheralInspector | None:
    """Resolve an inspector by name, optionally scoped to a silicon family.

    Accepts family-qualified names (``"stm32:I2C1"``). A bare name resolves
    only when exactly one family provides it; ambiguous names return None so
    the caller can surface the qualified alternatives.
    """
    name = name.strip()
    if family is None and ":" in name:
        family, name = name.split(":", 1)
    if family is not None:
        return _INSPECTORS.get(_key(family, name))
    upper = name.strip().upper()
    matches = [ins for (_fam, n), ins in _INSPECTORS.items() if n == upper]
    return matches[0] if len(matches) == 1 else None


def list_supported(family: str | None = None) -> list[str]:
    """Names an agent can pass to ``inspect_peripheral``.

    Names provided by a single family are listed bare; names shared across
    families are listed family-qualified (``"family:NAME"``).
    """
    if family is not None:
        fam = family.strip().lower()
        return sorted(n for (f, n) in _INSPECTORS if f == fam)
    counts = Counter(n for (_f, n) in _INSPECTORS)
    return sorted(
        n if counts[n] == 1 else f"{f}:{n}" for (f, n) in _INSPECTORS
    )


def list_families() -> list[str]:
    return sorted({f for (f, _n) in _INSPECTORS})


def _load_plugins() -> None:
    """Register inspectors published by third-party packages."""
    for ep in entry_points(group=PLUGIN_GROUP):
        try:
            provider = ep.load()
            for inspector in provider():
                register(inspector)
        except Exception as exc:  # noqa: BLE001 - plugin quality is unknown
            log.warning(
                "failed to load peripheral inspector plugin %r (%s): %s",
                ep.name,
                ep.value,
                exc,
            )


def _bootstrap() -> None:
    if _INSPECTORS:
        return
    from .stm32_i2c import default_i2c_inspectors

    for inspector in default_i2c_inspectors():
        register(inspector)
    _load_plugins()


_bootstrap()
