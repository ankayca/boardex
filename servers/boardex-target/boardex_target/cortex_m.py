"""Cortex-M architecture helpers: fault-register decoding and exception names.

This is *vendor-neutral* (it describes the ARM Cortex-M architecture, not pyOCD
or ST-Link) but *not* hardware-specific: the functions here are pure and take
already-read register values, so they can be unit-tested without a board and
reused by any future target adapter (J-Link, OpenOCD) that reads the same SCB
registers. That's why they live in the target server rather than in the pure
abstract ``boardex-core`` contract.

References: ARMv7-M Architecture Reference Manual, System Control Block (SCB).
"""

from __future__ import annotations

from typing import Any

# System Control Block register addresses (identical across all Cortex-M cores).
ICSR = 0xE000ED04  # Interrupt Control and State (VECTACTIVE lives here)
SHCSR = 0xE000ED24  # System Handler Control and State
CFSR = 0xE000ED28  # Configurable Fault Status (MMFSR|BFSR|UFSR)
HFSR = 0xE000ED2C  # HardFault Status
DFSR = 0xE000ED30  # Debug Fault Status
MMFAR = 0xE000ED34  # MemManage Fault Address
BFAR = 0xE000ED38  # BusFault Address

# (bit, short_name, human description) for each Configurable Fault Status bit.
_MMFSR_BITS = [
    (0, "IACCVIOL", "Instruction access violation"),
    (1, "DACCVIOL", "Data access violation"),
    (3, "MUNSTKERR", "MemManage fault while unstacking on exception return"),
    (4, "MSTKERR", "MemManage fault while stacking on exception entry"),
    (5, "MLSPERR", "MemManage fault during FP lazy state preservation"),
]
_BFSR_BITS = [
    (8, "IBUSERR", "Instruction bus error"),
    (9, "PRECISERR", "Precise data bus error (faulting address in BFAR)"),
    (10, "IMPRECISERR", "Imprecise data bus error (delayed write)"),
    (11, "UNSTKERR", "Bus fault while unstacking on exception return"),
    (12, "STKERR", "Bus fault while stacking on exception entry"),
    (13, "LSPERR", "Bus fault during FP lazy state preservation"),
]
_UFSR_BITS = [
    (16, "UNDEFINSTR", "Undefined instruction"),
    (17, "INVSTATE", "Invalid state (illegal EPSR / not in Thumb state)"),
    (18, "INVPC", "Invalid PC load (bad EXC_RETURN value)"),
    (19, "NOCP", "Coprocessor access denied (FPU disabled?)"),
    (24, "UNALIGNED", "Unaligned memory access"),
    (25, "DIVBYZERO", "Integer divide by zero"),
]
_HFSR_BITS = [
    (1, "VECTTBL", "Bus fault reading the exception vector table"),
    (30, "FORCED", "Forced HardFault (a configurable fault escalated)"),
    (31, "DEBUGEVT", "Debug event"),
]

_MMARVALID = 1 << 7
_BFARVALID = 1 << 15

# Cortex-M exception numbers (ICSR.VECTACTIVE). >= 16 are external interrupts.
_EXCEPTIONS = {
    0: "Thread mode (no active exception)",
    2: "NMI",
    3: "HardFault",
    4: "MemManage fault",
    5: "BusFault",
    6: "UsageFault",
    11: "SVCall",
    12: "Debug monitor",
    14: "PendSV",
    15: "SysTick",
}

# Exception numbers that mean the core is currently executing a fault handler.
_FAULT_EXCEPTIONS = {3, 4, 5, 6}

# On exception entry the core auto-stacks these 8 words (basic frame). An
# extended (FP) frame stacks more, but these first 8 are always in this order.
EXCEPTION_FRAME_REGS = ("r0", "r1", "r2", "r3", "r12", "lr", "pc", "xpsr")


def is_exc_return(lr: int) -> bool:
    """True if ``lr`` looks like an EXC_RETURN value (i.e. we're in a handler)."""
    return (lr & 0xFFFFFFF0) == 0xFFFFFFF0


def exc_return_uses_psp(exc_return: int) -> bool:
    """EXC_RETURN bit 2 selects which stack holds the stacked frame."""
    return bool(exc_return & 0x4)


def decode_exception_frame(words: list[int]) -> dict[str, int]:
    """Map the 8 auto-stacked words to register names (the pre-fault context).

    ``pc`` is the address of the faulting instruction (for precise faults) and
    is the single most useful field for locating a crash in source.
    """
    return dict(zip(EXCEPTION_FRAME_REGS, words[: len(EXCEPTION_FRAME_REGS)]))


def exception_name(vectactive: int) -> str:
    """Human name for an ICSR.VECTACTIVE exception number."""
    vectactive &= 0x1FF
    if vectactive >= 16:
        return f"IRQ{vectactive - 16}"
    return _EXCEPTIONS.get(vectactive, f"exception {vectactive}")


def _decode_bits(value: int, bits: list[tuple[int, str, str]]) -> list[dict[str, Any]]:
    return [
        {"bit": bit, "name": name, "description": desc}
        for bit, name, desc in bits
        if value & (1 << bit)
    ]


def decode_faults(
    cfsr: int,
    hfsr: int,
    *,
    mmfar: int | None = None,
    bfar: int | None = None,
) -> dict[str, Any]:
    """Decode CFSR/HFSR (+ fault-address regs) into a structured verdict.

    Returns a dict with ``faulted`` (bool), the list of ``active`` fault bits
    (each with name + description), a one-line ``reason``, the raw register
    values, and the faulting address(es) when the corresponding *VALID bit is
    set. Purely functional so it is trivially unit-testable.
    """
    active: list[dict[str, Any]] = []
    active += _decode_bits(cfsr, _MMFSR_BITS)
    active += _decode_bits(cfsr, _BFSR_BITS)
    active += _decode_bits(cfsr, _UFSR_BITS)
    active += _decode_bits(hfsr, _HFSR_BITS)

    faulted = bool(active)
    result: dict[str, Any] = {
        "faulted": faulted,
        "active": active,
        "cfsr": cfsr,
        "hfsr": hfsr,
    }

    if cfsr & _MMARVALID and mmfar is not None:
        result["mmfar"] = mmfar
    if cfsr & _BFARVALID and bfar is not None:
        result["bfar"] = bfar

    if not faulted:
        result["reason"] = "No fault latched (fault status registers are clear)."
        return result

    names = ", ".join(f"{a['name']} ({a['description']})" for a in active)
    reason = f"Latched fault(s): {names}."
    if "bfar" in result:
        reason += f" Faulting address (BFAR): {result['bfar']:#010x}."
    if "mmfar" in result:
        reason += f" Faulting address (MMFAR): {result['mmfar']:#010x}."
    result["reason"] = reason
    return result
