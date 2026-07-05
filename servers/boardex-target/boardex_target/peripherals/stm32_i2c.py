"""STM32 I2C v1 peripheral inspector (F0/F1/F3/L0/L1 and similar).

Register layout matches RM0316 (STM32F303). Additional instances or families
register new ``Stm32I2cInspector`` objects without changing the MCP tool.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .base import InspectResult, MemoryRead, PeripheralInspector
from .gpio_stm32 import decode_pin, gpio_base

RCC_BASE = 0x40021000
RCC_AHBENR = RCC_BASE + 0x14
RCC_APB1ENR = RCC_BASE + 0x1C

_I2C_BASE: dict[int, int] = {
    1: 0x40005400,
    2: 0x40005800,
}

# Default SCL/SDA pins for common Nucleo boards (overridable later via options).
_DEFAULT_PINS: dict[int, tuple[tuple[str, int], tuple[str, int]]] = {
    1: (("B", 8), ("B", 9)),  # I2C1 on NUCLEO-F303RE
    2: (("B", 10), ("B", 11)),
}


def _u32(block: bytes, offset: int = 0) -> int:
    return int.from_bytes(block[offset : offset + 4], "little")


def decode_i2c_cr1(value: int) -> dict[str, Any]:
    return {
        "raw": f"{value:#010x}",
        "PE": bool(value & (1 << 0)),
        "SMBUS": bool(value & (1 << 1)),
        "SMBTYPE": bool(value & (1 << 3)),
        "ENARP": bool(value & (1 << 4)),
        "ENPEC": bool(value & (1 << 5)),
        "ENGCA": bool(value & (1 << 6)),
        "NOSTRETCH": bool(value & (1 << 7)),
        "START": bool(value & (1 << 8)),
        "STOP": bool(value & (1 << 9)),
        "ACK": bool(value & (1 << 10)),
        "POS": bool(value & (1 << 11)),
        "PEC": bool(value & (1 << 12)),
        "ALERT": bool(value & (1 << 13)),
        "SWRST": bool(value & (1 << 15)),
    }


def decode_i2c_cr2(value: int) -> dict[str, Any]:
    freq = value & 0x3F
    return {
        "raw": f"{value:#010x}",
        "FREQ_MHz": freq,
        "ITERREN": bool(value & (1 << 8)),
        "ITEVTEN": bool(value & (1 << 9)),
        "ITBUFEN": bool(value & (1 << 10)),
        "DMAEN": bool(value & (1 << 11)),
        "LAST": bool(value & (1 << 12)),
    }


def decode_i2c_sr1(value: int) -> dict[str, Any]:
    return {
        "raw": f"{value:#010x}",
        "SB": bool(value & (1 << 0)),
        "ADDR": bool(value & (1 << 1)),
        "BTF": bool(value & (1 << 2)),
        "ADD10": bool(value & (1 << 3)),
        "STOPF": bool(value & (1 << 4)),
        "RXNE": bool(value & (1 << 6)),
        "TXE": bool(value & (1 << 7)),
        "BERR": bool(value & (1 << 8)),
        "ARLO": bool(value & (1 << 9)),
        "AF": bool(value & (1 << 10)),
        "OVR": bool(value & (1 << 11)),
        "PECERR": bool(value & (1 << 12)),
        "TIMEOUT": bool(value & (1 << 14)),
        "SMBALERT": bool(value & (1 << 15)),
    }


def decode_i2c_sr2(value: int) -> dict[str, Any]:
    return {
        "raw": f"{value:#010x}",
        "MSL": bool(value & (1 << 0)),
        "BUSY": bool(value & (1 << 1)),
        "TRA": bool(value & (1 << 2)),
        "GENCALL": bool(value & (1 << 4)),
        "SMBDEFAULT": bool(value & (1 << 5)),
        "SMBHOST": bool(value & (1 << 6)),
        "DUALF": bool(value & (1 << 7)),
        "PEC": (value >> 8) & 0xFF,
    }


def decode_i2c_ccr(value: int) -> dict[str, Any]:
    duty = bool(value & (1 << 15))
    fs = bool(value & (1 << 15))
    ccr = value & 0xFFF
    return {
        "raw": f"{value:#010x}",
        "CCR": ccr,
        "DUTY": duty,
        "F_S": fs,
    }


def _i2c_hints(
    cr1: dict[str, Any],
    sr1: dict[str, Any],
    sr2: dict[str, Any],
    pins: dict[str, Any],
    clocks: dict[str, Any],
) -> list[str]:
    hints: list[str] = []
    if not clocks.get("i2c_clock_enabled"):
        hints.append("I2C peripheral clock is disabled (RCC_APB1ENR.I2CxEN=0).")
    if not clocks.get("gpio_clock_enabled"):
        hints.append("GPIO port clock is disabled (RCC_AHBENR.IOPxEN=0).")
    for sig, pin in pins.items():
        if not pin.get("i2c_ready"):
            hints.append(
                f"{sig} ({pin['signal']}) is not AF open-drain — hardware I2C "
                f"will not drive the bus (mode={pin['mode']}, "
                f"output_type={pin['output_type']})."
            )
    if cr1.get("PE") and sr2.get("BUSY") and not sr1.get("SB") and not sr1.get("ADDR"):
        hints.append(
            "BUSY set with no SB/ADDR — bus may be stuck or pins not muxed to I2C."
        )
    if sr1.get("AF"):
        hints.append("AF (acknowledge failure) is latched — clear and check wiring.")
    if cr1.get("PE") and not sr1.get("SB") and not sr2.get("BUSY"):
        hints.append(
            "PE set but SB never appears on START — peripheral may not control pins."
        )
    return hints


@dataclass(frozen=True)
class Stm32I2cInspector:
    """Inspect one STM32 I2C instance and its default GPIO pins."""

    instance: int
    name: str
    family: str = "stm32"
    description: str = ""

    def __post_init__(self) -> None:
        if not self.description:
            object.__setattr__(
                self,
                "description",
                f"STM32 I2C{self.instance} (v1 peripheral) with default Nucleo pins",
            )

    @property
    def _base(self) -> int:
        base = _I2C_BASE.get(self.instance)
        if base is None:
            raise ValueError(f"No base address for I2C{self.instance}")
        return base

    @property
    def _rcc_bit(self) -> int:
        return 1 << (20 + self.instance)  # I2C1EN=21, I2C2EN=22

    def memory_reads(self) -> list[MemoryRead]:
        scl_port, scl_pin = _DEFAULT_PINS[self.instance][0]
        gpio_addr = gpio_base(scl_port)
        return [
            MemoryRead("i2c", self._base, 36),
            MemoryRead("gpio", gpio_addr, 40),
            MemoryRead("rcc", RCC_BASE + 0x14, 12),
        ]

    def decode(self, blocks: dict[str, bytes]) -> dict[str, Any]:
        i2c = blocks.get("i2c", b"")
        gpio = blocks.get("gpio", b"")
        rcc = blocks.get("rcc", b"")

        cr1 = _u32(i2c, 0x00)
        cr2 = _u32(i2c, 0x04)
        sr1 = _u32(i2c, 0x14)
        sr2 = _u32(i2c, 0x18)
        ccr = _u32(i2c, 0x1C)
        trise = _u32(i2c, 0x20)

        moder = _u32(gpio, 0x00)
        otyper = _u32(gpio, 0x04)
        afrl = _u32(gpio, 0x20)
        afrh = _u32(gpio, 0x24)

        scl_port, scl_pin = _DEFAULT_PINS[self.instance][0]
        sda_port, sda_pin = _DEFAULT_PINS[self.instance][1]

        ahbenr = _u32(rcc, 0x00)
        apb1enr = _u32(rcc, 0x08)
        port_bit = {"A": 17, "B": 18, "C": 19, "D": 20, "E": 21, "F": 22}

        pins = {
            "SCL": decode_pin(
                scl_port, scl_pin, moder=moder, otyper=otyper, afrl=afrl, afrh=afrh
            ),
            "SDA": decode_pin(
                sda_port, sda_pin, moder=moder, otyper=otyper, afrl=afrl, afrh=afrh
            ),
        }

        clocks = {
            "gpio_clock_enabled": bool(ahbenr & (1 << port_bit.get(scl_port, 18))),
            "i2c_clock_enabled": bool(apb1enr & self._rcc_bit),
            "RCC_AHBENR": f"{ahbenr:#010x}",
            "RCC_APB1ENR": f"{apb1enr:#010x}",
        }

        reg = {
            "CR1": decode_i2c_cr1(cr1),
            "CR2": decode_i2c_cr2(cr2),
            "SR1": decode_i2c_sr1(sr1),
            "SR2": decode_i2c_sr2(sr2),
            "CCR": decode_i2c_ccr(ccr),
            "TRISE": trise & 0x3F,
        }

        hints = _i2c_hints(reg["CR1"], reg["SR1"], reg["SR2"], pins, clocks)

        result = InspectResult(
            peripheral=self.name,
            family=self.family,
            registers=reg,
            pins=pins,
            clocks=clocks,
            hints=hints,
        )
        return result.to_dict()


def default_i2c_inspectors() -> list[Stm32I2cInspector]:
    return [
        Stm32I2cInspector(instance=1, name="I2C1"),
        Stm32I2cInspector(instance=2, name="I2C2"),
    ]
