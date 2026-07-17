"""RealBench unit coverage the fake fixture cannot exercise.

These construct a RealBench but never touch hardware: ``flash_approval`` is pure
policy. The point is the gate floor (audit MEDIUM-5) — the branch a falsey
``safety.flashRequiresApproval`` used to short-circuit, which the fake bench
(always flashRequiresApproval=true) never reached, which is why the bug shipped.
"""

from __future__ import annotations

from boardex_runner.bench import ApprovalSpec
from boardex_runner.real_bench import RealBench, RealBenchConfig


def _bench(*, flash_requires_approval: bool) -> RealBench:
    profile = {
        "id": "bp_test",
        "name": "Test board",
        "safety": {"flashRequiresApproval": flash_requires_approval},
    }
    return RealBench(RealBenchConfig(profile=profile, device_id="pyocd:stlink:test"))


def test_flash_gate_survives_falsey_flash_requires_approval() -> None:
    """A profile with flashRequiresApproval=false must NOT remove the flash
    gate: flashing mutates hardware, so approval is requested regardless."""
    bench = _bench(flash_requires_approval=False)
    spec = bench.flash_approval(1)
    assert isinstance(spec, ApprovalSpec)
    assert spec.risk_level == "medium"
    assert spec.hardware_actions  # names the flash it is gating


def test_flash_gate_present_when_profile_requires_it() -> None:
    bench = _bench(flash_requires_approval=True)
    spec = bench.flash_approval(1)
    assert isinstance(spec, ApprovalSpec)
    assert "Board profile" in spec.reason
