"""Unit tests for peripheral inspectors. No hardware."""

from __future__ import annotations

import struct

from boardex_target.peripherals import inspect, registry
from boardex_target.peripherals.stm32_i2c import (
    Stm32I2cInspector,
    decode_i2c_cr1,
    decode_i2c_sr1,
)


def _pack_u32(*values: int) -> bytes:
    return b"".join(struct.pack("<I", v) for v in values)


def test_registry_lists_i2c_instances():
    names = registry.list_supported()
    assert "I2C1" in names
    assert "I2C2" in names


def test_registry_is_family_keyed():
    assert registry.get("I2C1") is registry.get("stm32:I2C1")
    assert registry.get("I2C1", family="stm32") is not None
    assert registry.get("I2C1", family="nxp") is None
    assert "stm32" in registry.list_families()


def test_registry_qualifies_names_shared_across_families():
    class _NxpI2c:
        name = "I2C1"
        family = "nxp"
        description = "fake NXP I2C"

        def memory_reads(self):
            return []

        def decode(self, blocks):
            return {}

    registry.register(_NxpI2c())
    try:
        # Bare name is now ambiguous; qualified names resolve.
        assert registry.get("I2C1") is None
        assert registry.get("nxp:I2C1") is not None
        assert registry.get("stm32:I2C1") is not None
        names = registry.list_supported()
        assert "stm32:I2C1" in names and "nxp:I2C1" in names
    finally:
        del registry._INSPECTORS[("nxp", "I2C1")]


def test_decode_i2c_cr1_flags():
    decoded = decode_i2c_cr1(0x401)
    assert decoded["PE"] is True
    assert decoded["ACK"] is True


def test_decode_i2c_sr1_sb():
    assert decode_i2c_sr1(0x001)["SB"] is True


def test_inspect_i2c1_gpio_output_mode_hints():
    """Pins left in GPIO output (bus-recovery bug) should surface a hint."""
    profile = Stm32I2cInspector(instance=1, name="I2C1")
    # I2C: CR1=PE|ACK, CR2=8MHz, rest zero
    i2c_block = _pack_u32(0x401, 0x08, 0, 0, 0, 0, 0, 0, 0, 0)
    # GPIO: PB8/PB9 as output (01), open-drain
    moder = (1 << 16) | (1 << 18)
    gpio_block = _pack_u32(moder, 0x0300, 0, 0, 0, 0, 0, 0, 0, 0)
    # RCC: GPIOB + I2C1 clocks enabled
    rcc_block = _pack_u32(0x00040000, 0, 0x00200000)

    decoded = profile.decode(
        {"i2c": i2c_block, "gpio": gpio_block, "rcc": rcc_block[:12]}
    )
    assert decoded["pins"]["SCL"]["mode"] == "output"
    assert decoded["pins"]["SCL"]["i2c_ready"] is False
    assert any("not AF open-drain" in h for h in decoded["hints"])


def test_inspect_i2c1_af_open_drain_ready():
    profile = Stm32I2cInspector(instance=1, name="I2C1")
    moder = (2 << 16) | (2 << 18)  # AF mode on PB8/PB9
    afrh = (4 << 0) | (4 << 4)  # AF4 for both
    gpio_block = _pack_u32(moder, 0x0300, 0, 0, 0, 0, 0, 0, 0, afrh)
    i2c_block = _pack_u32(0x401, 0x08, 0, 0, 0, 0, 0, 0, 0, 0)
    rcc_block = _pack_u32(0x00040000, 0, 0x00200000)

    decoded = profile.decode(
        {"i2c": i2c_block, "gpio": gpio_block, "rcc": rcc_block[:12]}
    )
    assert decoded["pins"]["SCL"]["i2c_ready"] is True
    assert decoded["pins"]["SDA"]["alternate_function"] == 4


def test_inspect_orchestrator_unknown_peripheral():
    result = inspect.inspect(lambda a, l: b"", "SPI99")
    assert not result.ok
    assert "SPI99" in result.summary
    assert "I2C1" in result.data["supported"]


def test_inspect_orchestrator_success():
    profile = registry.get("I2C1")
    assert profile is not None
    blocks = {spec.label: b"\x00" * spec.length for spec in profile.memory_reads()}

    def read_block(address: int, length: int) -> bytes:
        for spec in profile.memory_reads():
            if spec.address == address and spec.length == length:
                return blocks[spec.label]
        return b"\x00" * length

    result = inspect.inspect(read_block, "I2C1")
    assert result.ok
    assert result.data["peripheral"] == "I2C1"
    assert "CR1" in result.data["registers"]
