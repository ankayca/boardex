"""STM32 GPIO register decoders shared by peripheral inspectors."""

from __future__ import annotations

from typing import Any

_GPIO_BASE: dict[str, int] = {
    "A": 0x48000000,
    "B": 0x48000400,
    "C": 0x48000800,
    "D": 0x48000C00,
    "E": 0x48001000,
    "F": 0x48001400,
}


def gpio_base(port: str) -> int:
    key = port.strip().upper()
    if key not in _GPIO_BASE:
        raise ValueError(f"Unknown GPIO port {port!r}; known: {sorted(_GPIO_BASE)}")
    return _GPIO_BASE[key]


def _u32(block: bytes, offset: int = 0) -> int:
    if len(block) < offset + 4:
        return 0
    b = block[offset : offset + 4]
    return int.from_bytes(b, "little")


def decode_pin(
    port: str,
    pin: int,
    *,
    moder: int,
    otyper: int,
    afrh: int | None = None,
    afrl: int | None = None,
) -> dict[str, Any]:
    """Decode one pin's mode, output type, and alternate function."""
    mode_bits = (moder >> (pin * 2)) & 0x3
    mode_names = ("input", "output", "alternate", "analog")
    mode = mode_names[mode_bits]
    otype = "open_drain" if (otyper >> pin) & 1 else "push_pull"

    af = None
    if mode == "alternate":
        if pin >= 8:
            shift = (pin - 8) * 4
            af = (afrh >> shift) & 0xF if afrh is not None else None
        else:
            shift = pin * 4
            af = (afrl >> shift) & 0xF if afrl is not None else None

    return {
        "port": port.upper(),
        "pin": pin,
        "signal": f"P{port.upper()}{pin}",
        "mode": mode,
        "output_type": otype,
        "alternate_function": af,
        "i2c_ready": mode == "alternate" and otype == "open_drain",
    }
