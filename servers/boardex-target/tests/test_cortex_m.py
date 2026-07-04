"""Unit tests for the Cortex-M fault decoder. No hardware required.

These lock down the crash-report semantics the agent branches on: a clear CFSR
means "not crashed", specific bits decode to specific reasons, and the faulting
address is surfaced only when its VALID bit is set.
"""

from __future__ import annotations

from boardex_target import cortex_m


def test_clear_registers_report_no_fault():
    decoded = cortex_m.decode_faults(cfsr=0, hfsr=0)
    assert decoded["faulted"] is False
    assert decoded["active"] == []
    assert "No fault" in decoded["reason"]


def test_divbyzero_usage_fault_decodes():
    # UFSR.DIVBYZERO is bit 25 of CFSR.
    decoded = cortex_m.decode_faults(cfsr=1 << 25, hfsr=0)
    assert decoded["faulted"] is True
    names = [a["name"] for a in decoded["active"]]
    assert "DIVBYZERO" in names


def test_precise_bus_fault_surfaces_bfar_only_when_valid():
    # BFSR.PRECISERR (bit 9) + BFARVALID (bit 15), forced HardFault (HFSR bit 30).
    cfsr = (1 << 9) | (1 << 15)
    decoded = cortex_m.decode_faults(
        cfsr=cfsr, hfsr=1 << 30, mmfar=0xDEAD, bfar=0x2000_1234
    )
    assert decoded["faulted"] is True
    assert decoded["bfar"] == 0x2000_1234
    # MMARVALID was not set, so MMFAR must not be reported even though passed.
    assert "mmfar" not in decoded
    assert "FORCED" in [a["name"] for a in decoded["active"]]
    assert "0x20001234" in decoded["reason"]


def test_exception_name_maps_numbers():
    assert cortex_m.exception_name(0).startswith("Thread")
    assert cortex_m.exception_name(3) == "HardFault"
    assert cortex_m.exception_name(6) == "UsageFault"
    assert cortex_m.exception_name(16 + 5) == "IRQ5"


def test_exc_return_detection_and_stack_select():
    # A HardFault-entry EXC_RETURN using MSP / thread mode.
    assert cortex_m.is_exc_return(0xFFFFFFF9) is True
    assert cortex_m.is_exc_return(0x08000123) is False
    # bit 2 clear -> MSP, set -> PSP.
    assert cortex_m.exc_return_uses_psp(0xFFFFFFF9) is False
    assert cortex_m.exc_return_uses_psp(0xFFFFFFFD) is True


def test_decode_exception_frame_maps_stacked_pc():
    words = [0, 1, 2, 3, 12, 0xAAAA, 0x08000456, 0x61000000]
    frame = cortex_m.decode_exception_frame(words)
    # The stacked PC (7th word) is the faulting instruction address.
    assert frame["pc"] == 0x08000456
    assert frame["lr"] == 0xAAAA
    assert frame["xpsr"] == 0x61000000
