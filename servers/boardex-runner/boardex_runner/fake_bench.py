"""Deterministic hardware-free bench: the BME280 bring-up arc in code.

Simulates the §5.5 story shape — iteration 1 fails on device ACK (address
shift bug), diagnosis proposes a fix behind an approval, iteration 2 passes —
through the exact same engine and wire layer the real bench uses. With
``fail_variant=True`` iteration 2's checks fail again and the run ends in
``run.failed`` with nothing further to propose.

All content is generated here (never read from the UI owner's fixture files);
decode annotations follow the house ``parse.py`` shape:
``raw == f"{start}-{end} {decoder}: {text}"``.
"""

from __future__ import annotations

from typing import Any

from .bench import (
    ApprovalSpec,
    ArtifactSpec,
    CheckSpec,
    DiagnosisSpec,
    LogChunk,
    PlanSpec,
    StepResult,
)
from .contract import CONTRACT_VERSION

FAKE_PROBE_ID = "fake:stlink:BENCHSIM0001"
FAKE_SERIAL_ID = "serial:/dev/ttyACM0"
FAKE_LA_ID = "fake:kingst-la2016:sim"


def _annotation(start: int, end: int, decoder: str, text: str) -> dict[str, Any]:
    return {
        "raw": f"{start}-{end} {decoder}: {text}",
        "start": start,
        "end": end,
        "decoder": decoder,
        "text": text,
    }


def _decode_content(*, acked: bool, wire_byte: int) -> dict[str, Any]:
    annotations: list[dict[str, Any]] = []
    transactions: list[dict[str, Any]] = []
    base = 812_000
    suffix = "ACK" if acked else "NACK"
    for i in range(3):
        start = base + i * 4_000
        annotations.append(_annotation(start, start + 10, "i2c-1", "START"))
        annotations.append(
            _annotation(
                start + 10, start + 370, "i2c-1", f"ADDRESS WRITE: {wire_byte >> 1:02X} {suffix}"
            )
        )
        annotations.append(_annotation(start + 370, start + 380, "i2c-1", "STOP"))
        transactions.append(
            {
                "addr_7bit": wire_byte >> 1,
                "rw": "w",
                "write": [0xD0] if acked else [],
                "read": [],
                "nack_at": None if acked else "address",
            }
        )
    return {
        "protocol": "i2c",
        "device_id": FAKE_LA_ID,
        "channel_map": {"scl": 0, "sda": 1},
        "sample_rate_hz": 4_000_000,
        "num_samples": 8_000_000,
        "duration_s": 2,
        "bus_state": "decoded_ok",
        "annotations": annotations,
        "transactions": transactions,
    }


_BUILD_LOG = "\n".join(
    [
        "make: Entering directory '/bench/firmware/bme280-f303re'",
        "arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -O2 -Wall -Wextra -c main.c -o main.o",
        "arm-none-eabi-gcc -T linker.ld -nostartfiles main.o -o bme280-f303re.elf",
        "arm-none-eabi-size bme280-f303re.elf",
        "   text    data     bss     dec     hex filename",
        "   4712      12    1568    6292    1894 bme280-f303re.elf",
        "make: Leaving directory '/bench/firmware/bme280-f303re'",
        "",
    ]
)

_FLASH_LOG = "\n".join(
    [
        "0001204 I Target type is stm32f303retx [board]",
        "0001630 I DP IDR = 0x2ba01477 (v1 rev2) [dap]",
        "0002233 I Erased 8192 bytes (2 sectors), programmed 8192 bytes (4 pages)",
        "0002240 I Verified 8192 bytes in 0.081s",
        "0002251 I Target reset and released from reset",
        "",
    ]
)

_SERIAL_FAIL_LINES = [
    "BME280 bring-up firmware (Boardex bench)",
    "sysclk 8 MHz HSI, USART2 115200 8N1",
    "I2C1: 100 kHz standard mode on PB8/PB9",
    "I2C1 ERROR: timeout waiting for TXIS (read setup)",
    "BME280 ERROR: chip id read failed (attempt 1/3)",
    "I2C1 ERROR: timeout waiting for TXIS (read setup)",
    "BME280 ERROR: chip id read failed (attempt 2/3)",
    "I2C1 ERROR: timeout waiting for TXIS (read setup)",
    "BME280 FATAL: sensor unreachable, halting reads",
]

_SERIAL_PASS_LINES = [
    "BME280 bring-up firmware (Boardex bench)",
    "sysclk 8 MHz HSI, USART2 115200 8N1",
    "I2C1: 100 kHz standard mode on PB8/PB9",
    "BME280: chip id 0x60 OK",
    "BME280: calibration loaded, oversampling x1",
    "TEMP=24.3 HUM=41.2",
    "TEMP=24.3 HUM=41.1",
    "TEMP=24.4 HUM=41.2",
]

_DIFF_ITER1 = {
    "files": [
        {
            "path": "main.c",
            "reason": (
                "Add a register-level I2C1 driver (PB8/PB9, 100 kHz) and a BME280 "
                "init/read loop printing TEMP/HUM over USART2."
            ),
            "diff": (
                "--- a/main.c\n+++ b/main.c\n@@ -1,5 +1,120 @@\n"
                " #include <stdint.h>\n"
                "+#define BME280_ADDR 0x76u\n"
                "+static void i2c1_init(void) { /* 100 kHz TIMINGR for 8 MHz HSI */ }\n"
                "+static int bme280_read_id(uint8_t *id) { /* CR2 SADD = BME280_ADDR */ }\n"
            ),
        }
    ]
}

_DIFF_ITER2 = {
    "files": [
        {
            "path": "main.c",
            "reason": (
                "I2C1 CR2 SADD[7:1] expects the 7-bit address in wire-byte position; "
                "iteration 1 loaded 0x76 unshifted, addressing 0x3B. Shift the address "
                "left by one in every CR2 load."
            ),
            "diff": (
                "--- a/main.c\n+++ b/main.c\n@@ -60,7 +60,8 @@\n"
                " #define BME280_ADDR 0x76u\n"
                "+#define BME280_SADD ((uint32_t)BME280_ADDR << 1)\n"
                "-    I2C1->CR2 = (BME280_ADDR) | ...;\n"
                "+    I2C1->CR2 = (BME280_SADD) | ...;\n"
            ),
        }
    ]
}


def _timing_content(value_hz: int) -> dict[str, Any]:
    return {"measurement": "logic_analyzer.i2c.scl_frequency", "valueHz": value_hz}


def _report_md(fail: bool) -> str:
    verdict = "FAILED — hardware fault suspected" if fail else "PASSED on iteration 2"
    return "\n".join(
        [
            "# BME280 bring-up validation report",
            "",
            f"**Verdict:** {verdict}",
            "",
            "## Checks",
            "",
            "| Requirement | Verdict | Evidence |",
            "|---|---|---|",
            "| i2c_clock | pass | SCL timing measurement |",
            f"| device_ack | {'fail' if fail else 'pass'} | I2C protocol decode |",
            f"| serial_output | {'fail' if fail else 'pass'} | Serial log |",
            "",
            "## Root cause (iteration 1)",
            "",
            "7-bit address 0x76 was loaded unshifted into I2C1 CR2 SADD, addressing 0x3B.",
            "",
        ]
    )


class FakeBench:
    """Deterministic simulated bench; every stage is pure data."""

    blocking = False

    def __init__(self, *, fail_variant: bool = False) -> None:
        self.fail_variant = fail_variant
        self.halted = False

    # -- bench snapshot --------------------------------------------------------

    def bench_status(self) -> dict[str, Any]:
        return {
            "runnerOnline": True,
            "contractVersion": CONTRACT_VERSION,
            "devices": [
                {
                    "id": FAKE_PROBE_ID,
                    "kind": "debug_probe",
                    "name": "ST-Link/V2-1 (simulated)",
                    "state": "online",
                    "detail": "stm32f303retx",
                },
                {
                    "id": FAKE_SERIAL_ID,
                    "kind": "serial",
                    "name": "USART2 over ST-Link VCP (simulated)",
                    "state": "online",
                    "detail": "115200 8N1",
                },
                {
                    "id": FAKE_LA_ID,
                    "kind": "logic_analyzer",
                    "name": "Kingst LA2016 (simulated)",
                    "state": "online",
                    "detail": "16 channels, sampling to 200 MHz",
                },
            ],
        }

    # -- plan -------------------------------------------------------------------

    def plan(self, task_prompt: str, profile: dict[str, Any]) -> PlanSpec:
        board = profile.get("name", "the target board")
        return PlanSpec(
            steps=[
                {
                    "index": 0,
                    "title": "Understand the task and board context",
                    "detail": f"Read the board profile for {board} and the sensor datasheet; "
                    "confirm bus wiring and the device address.",
                    "riskLevel": "low",
                    "hardwareAction": False,
                },
                {
                    "index": 1,
                    "title": "Modify firmware for the sensor",
                    "detail": "Add an I2C driver and a sensor init/read loop; print readings "
                    "over the serial console.",
                    "riskLevel": "low",
                    "hardwareAction": False,
                },
                {
                    "index": 2,
                    "title": "Build and flash the firmware",
                    "detail": "Compile with the profile's build command and program the ELF "
                    "via the debug probe. Flashing needs approval.",
                    "riskLevel": "medium",
                    "hardwareAction": True,
                },
                {
                    "index": 3,
                    "title": "Capture the bus and serial output",
                    "detail": "Decode SCL/SDA with the logic analyzer while reading the "
                    "serial console.",
                    "riskLevel": "low",
                    "hardwareAction": False,
                },
                {
                    "index": 4,
                    "title": "Validate measurements against the spec",
                    "detail": "Check SCL frequency (100 kHz ±10%), device ACK, and sensor "
                    "readings on serial.",
                    "riskLevel": "low",
                    "hardwareAction": False,
                },
                {
                    "index": 5,
                    "title": "Produce the evidence-linked report",
                    "detail": "Summarize results with every conclusion linked to a physical "
                    "artifact.",
                    "riskLevel": "low",
                    "hardwareAction": False,
                },
            ],
            risk_summary="One medium-risk hardware action: flashing new firmware via the "
            "debug probe (requires approval). All other steps are software-side or read-only.",
        )

    # -- pipeline stages ---------------------------------------------------------

    def understand_context(self, iteration: int) -> StepResult | None:
        if iteration != 1:
            return None
        return StepResult(
            ok=True,
            summary="Confirmed I2C1 on PB8/PB9 and 7-bit address 0x76 (SDO low).",
            logs=[
                LogChunk(
                    "agent",
                    [
                        "Reading board profile: I2C1 on PB8 (SCL) / PB9 (SDA).",
                        "Datasheet §5.4.1: SDO low selects 7-bit address 0x76.",
                    ],
                    delay_ms=1800,
                )
            ],
            delay_ms=800,
        )

    def edit_code(self, iteration: int) -> StepResult | None:
        if iteration == 1:
            return StepResult(
                ok=True,
                summary="Added register-level I2C1 driver and BME280 read loop.",
                logs=[
                    LogChunk(
                        "agent",
                        ["Writing i2c1_init(), bme280_read_id(), TEMP/HUM print loop."],
                        delay_ms=2200,
                    )
                ],
                artifacts=[
                    ArtifactSpec(
                        name=f"diff_iter{iteration}",
                        kind="code_diff",
                        label="Code changes — BME280 driver",
                        content=_DIFF_ITER1,
                    )
                ],
                delay_ms=600,
            )
        return StepResult(
            ok=True,
            summary="Applied the I2C address-shift fix (SADD = 0x76 << 1).",
            logs=[
                LogChunk(
                    "agent",
                    ["Shifting the 7-bit address into wire-byte position in CR2."],
                    delay_ms=1500,
                )
            ],
            artifacts=[
                ArtifactSpec(
                    name=f"diff_iter{iteration}",
                    kind="code_diff",
                    label="Code changes — address-shift fix",
                    content=_DIFF_ITER2,
                )
            ],
            delay_ms=500,
        )

    def build(self, iteration: int) -> StepResult:
        return StepResult(
            ok=True,
            summary="Firmware built: bme280-f303re.elf (4712 bytes text).",
            logs=[LogChunk("build", _BUILD_LOG.rstrip("\n").split("\n"), delay_ms=1600)],
            artifacts=[
                ArtifactSpec(
                    name=f"build_log_iter{iteration}",
                    kind="build_log",
                    label=f"Build log (iteration {iteration})",
                    content=_BUILD_LOG,
                )
            ],
            delay_ms=400,
        )

    def flash_approval(self, iteration: int) -> ApprovalSpec | None:
        if iteration != 1:
            return None  # the fix approval covers the iteration-2 re-flash
        return ApprovalSpec(
            title="Flash firmware to the target",
            reason="The iteration-1 build must be programmed to the target before "
            "capture. Board profile marks flashing as approval-required.",
            risk_level="medium",
            files_changed=[],
            hardware_actions=["Flash bme280-f303re.elf via the debug probe"],
            status_reason="Flash requires approval (board profile safety)",
        )

    def flash(self, iteration: int) -> StepResult:
        return StepResult(
            ok=True,
            summary="Programmed and verified 8192 bytes; target reset.",
            logs=[LogChunk("flash", _FLASH_LOG.rstrip("\n").split("\n"), delay_ms=1400)],
            artifacts=[
                ArtifactSpec(
                    name=f"flash_log_iter{iteration}",
                    kind="flash_log",
                    label=f"Flash log (iteration {iteration})",
                    content=_FLASH_LOG,
                )
            ],
            delay_ms=500,
        )

    def capture(self, iteration: int) -> StepResult | None:
        acked = iteration >= 2 and not self.fail_variant
        # The fail variant's whole point: the CORRECTED wire byte still NACKs.
        wire_byte = 0x76 << 1
        decode = _decode_content(acked=acked, wire_byte=wire_byte)
        timing = _timing_content(99_600 if iteration == 1 else 99_700)
        summary = (
            "Captured and decoded I2C: SCL in spec, device ACKs."
            if acked
            else "Captured and decoded I2C: SCL in spec, but every address phase NACKed."
        )
        return StepResult(
            ok=True,
            summary=summary,
            logs=[
                LogChunk(
                    "agent",
                    [
                        "Arming the logic analyzer on SCL/SDA; resetting target.",
                        "Capture complete: 8,000,000 samples in 2.0 s.",
                        f"I2C decode: 3 transactions, "
                        f"{'all ACKed' if acked else 'every address phase NACKed'}.",
                    ],
                    delay_ms=2600,
                )
            ],
            artifacts=[
                ArtifactSpec(
                    name=f"i2c_decode_iter{iteration}",
                    kind="protocol_decode",
                    label=f"I2C protocol decode (iteration {iteration})",
                    content=decode,
                ),
                ArtifactSpec(
                    name=f"scl_timing_iter{iteration}",
                    kind="timing_measurement",
                    label=f"SCL frequency measurement (iteration {iteration})",
                    content=timing,
                ),
            ],
            delay_ms=700,
        )

    def read_serial(self, iteration: int) -> StepResult:
        passing = iteration >= 2 and not self.fail_variant
        lines = _SERIAL_PASS_LINES if passing else _SERIAL_FAIL_LINES
        return StepResult(
            ok=True,
            summary=(
                "Serial streams TEMP/HUM readings."
                if passing
                else "60 s of serial captured: I2C timeouts on every access, no TEMP/HUM."
            ),
            logs=[
                LogChunk("serial", lines[:3], delay_ms=1200),
                LogChunk("serial", lines[3:], delay_ms=1600),
            ],
            artifacts=[
                ArtifactSpec(
                    name=f"serial_log_iter{iteration}",
                    kind="serial_log",
                    label=f"Serial log (iteration {iteration})",
                    content="\n".join(lines) + "\n",
                )
            ],
            delay_ms=600,
        )

    def evaluate(self, iteration: int) -> tuple[StepResult, list[CheckSpec]]:
        passing = iteration >= 2 and not self.fail_variant
        checks = [
            CheckSpec(
                requirement_id="i2c_clock",
                description="I2C SCL clock must be 100 kHz ±10%",
                measurement="logic_analyzer.i2c.scl_frequency",
                expected={"min": 90_000, "max": 110_000},
                actual={"value": 99_600 if iteration == 1 else 99_700, "unit": "Hz"},
                verdict="pass",
                artifact_name=f"scl_timing_iter{iteration}",
            ),
            CheckSpec(
                requirement_id="device_ack",
                description="BME280 must ACK its 7-bit address 0x76",
                measurement="logic_analyzer.i2c.device_ack",
                expected={"equals": True},
                actual={"value": passing},
                verdict="pass" if passing else "fail",
                artifact_name=f"i2c_decode_iter{iteration}",
                source_ref="BME280 datasheet §5.4.1",
            ),
            CheckSpec(
                requirement_id="serial_output",
                description="Serial console must print TEMP=<t> HUM=<h> readings",
                measurement="serial.console.output_pattern",
                expected={"pattern": "TEMP=\\d+\\.\\d HUM=\\d+\\.\\d"},
                actual={
                    "value": "TEMP=24.3 HUM=41.2" if passing else "no TEMP/HUM line in output"
                },
                verdict="pass" if passing else "fail",
                artifact_name=f"serial_log_iter{iteration}",
            ),
        ]
        failed = sum(1 for check in checks if check.verdict == "fail")
        summary = (
            "All 3 checks pass."
            if failed == 0
            else f"{failed} of 3 checks failed"
            + (" after the fix" if iteration >= 2 else "")
            + "."
        )
        step = StepResult(ok=failed == 0, summary=summary, delay_ms=800)
        return step, checks

    def diagnose(
        self, iteration: int, failed: list[dict[str, Any]]
    ) -> tuple[StepResult, DiagnosisSpec]:
        if iteration == 1:
            step = StepResult(
                ok=True,
                summary="Root cause identified with high confidence: address shift.",
                logs=[
                    LogChunk(
                        "agent",
                        [
                            "Decode shows NACK at every address phase; SCL timing is in spec.",
                            "Hypothesis: 7-bit address loaded unshifted into CR2 SADD.",
                        ],
                        delay_ms=2000,
                    )
                ],
                delay_ms=700,
            )
            diagnosis = DiagnosisSpec(
                hypotheses=[
                    {
                        "cause": "7-bit address 0x76 loaded into I2C1 CR2 SADD unshifted, "
                        "addressing 0x3B on the wire",
                        "evidence": "Protocol decode: every address phase NACKed while SCL "
                        "timing is in spec.",
                        "confidence": "high",
                    },
                    {
                        "cause": "Missing or weak SDA/SCL pull-ups",
                        "evidence": "Bus idles high and edges are clean in the capture.",
                        "confidence": "low",
                    },
                    {
                        "cause": "Sensor init ordering before bus ready",
                        "evidence": "First transaction already NACKs at the address phase.",
                        "confidence": "low",
                    },
                ],
                proposed_fix={
                    "summary": "Shift the 7-bit address into wire-byte position "
                    "(SADD = 0x76 << 1) and re-flash.",
                    "riskLevel": "medium",
                    "filesChanged": ["main.c"],
                },
                fix_approval=ApprovalSpec(
                    title="Apply I2C address-shift fix and re-flash",
                    reason="CR2 SADD[7:1] takes the address in wire-byte position; "
                    "iteration 1 addressed 0x3B and was NACKed.",
                    risk_level="medium",
                    files_changed=["main.c"],
                    hardware_actions=["Re-flash the corrected firmware via the debug probe"],
                    status_reason="Fix plan requires approval",
                ),
            )
            return step, diagnosis
        # Iteration >= 2 still failing: the corrected address faces dead hardware —
        # nothing left to propose (§5.7 rule 4: diagnosing -> failed).
        step = StepResult(
            ok=True,
            summary="The corrected address still NACKs; no firmware fix remains.",
            logs=[
                LogChunk(
                    "agent",
                    [
                        "Decode shows NACKs at the corrected wire byte 0xEC.",
                        "UART shows the same timeout signature as iteration 1.",
                        "No further firmware hypothesis; suspect sensor or wiring.",
                    ],
                    delay_ms=1800,
                )
            ],
            delay_ms=700,
        )
        diagnosis = DiagnosisSpec(
            hypotheses=[
                {
                    "cause": "Sensor not powered or wiring fault on SDA/SCL/VCC",
                    "evidence": "Correct wire byte 0xEC NACKs on every address phase.",
                    "confidence": "moderate",
                },
                {
                    "cause": "Defective BME280 breakout",
                    "evidence": "Bus timing in spec, correct address, no ACK.",
                    "confidence": "moderate",
                },
            ],
            proposed_fix={
                "summary": "No viable firmware fix; hardware inspection required.",
                "riskLevel": "low",
                "filesChanged": [],
            },
            fix_approval=None,
        )
        return step, diagnosis

    def iteration_reason(self, iteration: int) -> str:
        return (
            "Applying the I2C address-shift fix (SADD = 0x76 << 1); "
            "iteration 1 addressed 0x3B and was NACKed."
        )

    def report(self, iteration: int) -> StepResult:
        return StepResult(
            ok=True,
            summary="Validation report generated.",
            logs=[
                LogChunk(
                    "agent",
                    [
                        "Writing evidence-linked validation report: objective, procedure, "
                        "measurements, root cause, artifacts index."
                    ],
                    delay_ms=1500,
                )
            ],
            artifacts=[
                ArtifactSpec(
                    name="report",
                    kind="report_md",
                    label="Validation report",
                    content=_report_md(fail=False),
                )
            ],
            delay_ms=600,
        )

    def run_summary(self, iteration: int, completed: bool) -> str:
        if completed:
            return (
                f"BME280 bring-up validated on iteration {iteration}: SCL 99.7 kHz, "
                "device ACKs at 0x76, serial streams TEMP/HUM."
            )
        return (
            f"Iteration {iteration} applied the address-shift fix, but the sensor still "
            "does not answer: every address phase NACKs at wire byte 0xEC and no "
            "TEMP/HUM output appears. Suspect wiring or a defective breakout."
        )

    def halt(self) -> None:
        self.halted = True


def fake_board_profile() -> dict[str, Any]:
    """The canned board profile the fake bench serves (same id the UI/mock use)."""
    return {
        "id": "bp_nucleo_f303re",
        "name": "Nucleo-F303RE",
        "mcu": "STM32F303RE (Cortex-M4)",
        "repoPath": "/bench/firmware/bme280-f303re",
        "buildCommand": "make clean && make",
        "flashCommand": "pyocd flash --target stm32f303retx bme280-f303re.elf",
        "resetCommand": "pyocd reset --target stm32f303retx",
        "serial": {"port": "/dev/ttyACM0", "baud": 115200},
        "instruments": {"debugProbe": FAKE_PROBE_ID, "logicAnalyzer": FAKE_LA_ID},
        "safety": {
            "maxIterations": 3,
            "flashRequiresApproval": True,
            "powerNote": "Manual power: board powered over USB, 3V3 confirmed.",
        },
        "connectionChecklist": [
            {"label": "SCL — PB8", "detail": "Nucleo PB8 (CN10-3) to BME280 SCL"},
            {"label": "SDA — PB9", "detail": "Nucleo PB9 (CN10-5) to BME280 SDA"},
            {"label": "VCC — 3V3", "detail": "Nucleo 3V3 (CN7-16) to BME280 VCC"},
            {"label": "GND", "detail": "Nucleo GND (CN7-20) to BME280 GND"},
        ],
        "knownQuirks": [
            "8 MHz HSI clock — I2C1 TIMINGR must be recomputed if the clock tree changes."
        ],
    }