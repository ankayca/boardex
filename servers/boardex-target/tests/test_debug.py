"""Tests for Phase 2 halt-mode debugging. No hardware.

``pyocd_ops`` debug helpers are exercised through a fake that mimics the pyOCD
``Target`` API (the State enum comes from the installed pyOCD, everything else
is in-memory), and the adapter's session-required guard is checked directly.
"""

from __future__ import annotations

import pytest

from pyocd.core.target import Target

from boardex_core import SupportsHaltModeDebug
from boardex_core.testing import FakeTargetController
from boardex_target import pyocd_ops
from boardex_target.adapters.pyocd_adapter import PyOcdAdapter
from boardex_target.session import ManagedSession, SessionManager


class _FakeCore:
    available_breakpoint_count = 5

    class _BpMgr:
        def get_breakpoints(self):
            return [0x0800_0100]

    class _Dwt:
        watchpoint_count = 4

        def get_watchpoints(self):
            return []

    def __init__(self):
        self.bp_manager = self._BpMgr()
        self.dwt = self._Dwt()


class FakeTarget:
    """Mimics the subset of pyOCD's Target API the debug ops call."""

    def __init__(self, *, halted: bool = True, bp_slots: int = 6):
        self._state = Target.State.HALTED if halted else Target.State.RUNNING
        self._bps: set[int] = set()
        self._wps: set = set()
        self._bp_slots = bp_slots
        self._halt_countdown: int | None = None
        self.regs = {
            "pc": 0x0800_0100,
            "sp": 0x2000_1000,
            "lr": 0xFFFF_FFF9,
            "r0": 1,
            "xpsr": 0,
        }
        self.steps = 0
        self.selected_core = _FakeCore()

    def get_state(self):
        if self._state == Target.State.RUNNING and self._halt_countdown is not None:
            if self._halt_countdown <= 0:
                self._state = Target.State.HALTED
            else:
                self._halt_countdown -= 1
        return self._state

    def is_halted(self):
        return self._state == Target.State.HALTED

    def halt(self):
        self._state = Target.State.HALTED

    def resume(self):
        self._state = Target.State.RUNNING

    def arm_stop_after(self, polls: int) -> None:
        """Make the next ``get_state`` loop see HALTED after ``polls`` polls."""
        self._halt_countdown = polls

    def find_breakpoint(self, addr):
        return addr if addr in self._bps else None

    def set_breakpoint(self, addr, type=Target.BreakpointType.AUTO):
        if len(self._bps) >= self._bp_slots:
            return False
        self._bps.add(addr)
        return True

    def remove_breakpoint(self, addr):
        self._bps.discard(addr)

    def set_watchpoint(self, addr, size, wtype):
        self._wps.add((addr, size))
        return True

    def remove_watchpoint(self, addr, size, wtype):
        self._wps.discard((addr, size))

    def step(self, disable_interrupts=True, start=0, end=0, hook_cb=None):
        self.steps += 1
        self.regs["pc"] += 2

    def read_core_register(self, name):
        return self.regs.get(name, 0)

    def write_core_register(self, name, value):
        self.regs[name] = value

    def read_memory_block32(self, addr, count):
        return [0] * count


class FakeSession:
    def __init__(self, target: FakeTarget):
        self.target = target


# -- breakpoints -----------------------------------------------------------


def test_set_breakpoint_is_idempotent():
    session = FakeSession(FakeTarget())
    first = pyocd_ops.set_breakpoint(session, 0x0800_0200)
    assert first.ok and first.data["already_set"] is False
    again = pyocd_ops.set_breakpoint(session, 0x0800_0200)
    assert again.ok and again.data["already_set"] is True


def test_set_breakpoint_reports_no_slot_free_as_error():
    session = FakeSession(FakeTarget(bp_slots=1))
    assert pyocd_ops.set_breakpoint(session, 0x1).ok
    out = pyocd_ops.set_breakpoint(session, 0x2)
    assert out.verdict.value == "error"
    assert "no hardware breakpoint slot free" in out.summary.lower()


def test_clear_breakpoint_when_absent_is_pass_noop():
    session = FakeSession(FakeTarget())
    out = pyocd_ops.clear_breakpoint(session, 0xDEAD)
    assert out.ok and out.data["was_set"] is False


# -- watchpoints -----------------------------------------------------------


def test_set_watchpoint_rejects_unknown_access():
    session = FakeSession(FakeTarget())
    out = pyocd_ops.set_watchpoint(session, 0x2000_0000, access="sideways")
    assert out.verdict.value == "error"


def test_set_watchpoint_ok():
    session = FakeSession(FakeTarget())
    out = pyocd_ops.set_watchpoint(session, 0x2000_0000, size=4, access="write")
    assert out.ok and out.data["access"] == "write"


# -- registers & step ------------------------------------------------------


def test_read_registers_requires_halted_core():
    running = FakeSession(FakeTarget(halted=False))
    assert pyocd_ops.read_registers(running).verdict.value == "error"

    halted = FakeSession(FakeTarget(halted=True))
    out = pyocd_ops.read_registers(halted)
    assert out.ok and "pc" in out.data


def test_write_register_round_trips():
    session = FakeSession(FakeTarget(halted=True))
    out = pyocd_ops.write_register(session, "r0", 0x1234)
    assert out.ok and out.data["readback"] == 0x1234


def test_step_halts_a_running_core_and_advances_pc():
    target = FakeTarget(halted=False)
    session = FakeSession(target)
    out = pyocd_ops.step_core(session, count=3)
    assert out.ok
    assert out.data["steps"] == 3
    assert out.data["halted_by_this_call"] is True
    assert target.steps == 3


# -- run_until -------------------------------------------------------------


def test_run_until_stops_on_breakpoint():
    target = FakeTarget(halted=True)
    session = FakeSession(target)
    target.arm_stop_after(0)  # halt on the first poll after resume
    out = pyocd_ops.run_until(session, address=0x0800_0300, timeout_s=1.0)
    assert out.ok
    assert out.data["timed_out"] is False
    assert out.data["reason"] == "breakpoint"
    assert out.data["breakpoint_set_by_this_call"] is True


def test_run_until_times_out_and_halts_core():
    target = FakeTarget(halted=True)
    session = FakeSession(target)
    # never arm a stop: the core keeps "running" until the deadline
    out = pyocd_ops.run_until(session, address=0x0800_0400, timeout_s=0.05)
    assert out.verdict.value == "fail"
    assert out.data["timed_out"] is True
    assert target.is_halted()  # run_until must leave the core halted


def test_run_until_steps_off_a_breakpoint_parked_at_current_pc():
    # Core is halted sitting exactly on a breakpoint (as after a prior hit). A
    # naive resume would re-trigger it without progress; run_until must step off
    # it first. arm_stop_after(0) makes the post-resume poll see HALTED.
    target = FakeTarget(halted=True)
    target._bps.add(target.regs["pc"])  # stale breakpoint at current PC
    pc_before = target.regs["pc"]
    session = FakeSession(target)
    target.arm_stop_after(0)
    out = pyocd_ops.run_until(session, address=0x0800_0900, timeout_s=1.0)
    assert out.ok
    assert target.steps >= 1  # stepped off the parked breakpoint
    assert target.regs["pc"] != pc_before
    assert target.find_breakpoint(pc_before) is not None  # bp restored


def test_step_core_progresses_even_when_parked_on_a_breakpoint():
    target = FakeTarget(halted=True)
    target._bps.add(target.regs["pc"])
    pc_before = target.regs["pc"]
    out = pyocd_ops.step_core(FakeSession(target), count=1)
    assert out.ok
    assert target.regs["pc"] != pc_before
    assert target.find_breakpoint(pc_before) is not None  # bp restored


def test_run_until_errors_when_no_breakpoint_slot():
    target = FakeTarget(halted=True, bp_slots=0)
    session = FakeSession(target)
    out = pyocd_ops.run_until(session, address=0x0800_0500, timeout_s=0.1)
    assert out.verdict.value == "error"


# -- debug_resources -------------------------------------------------------


def test_debug_resources_reports_capacity():
    session = FakeSession(FakeTarget())
    out = pyocd_ops.debug_resources(session)
    assert out.ok
    assert out.data["hw_breakpoints_free"] == 5
    assert out.data["watchpoints_total"] == 4
    assert out.data["watchpoints_free"] == 4


# -- adapter: session is mandatory for halt-mode ---------------------------


def test_adapter_halt_mode_requires_open_session():
    adapter = PyOcdAdapter(SessionManager())
    out = adapter.set_breakpoint("pyocd:none", "main")
    assert out.verdict.value == "error"
    assert "session" in out.summary.lower()

    out2 = adapter.run_until("pyocd:none", "main")
    assert out2.verdict.value == "error"


def _managed_with_target(manager: SessionManager, device_id: str, target: FakeTarget):
    """Insert a ManagedSession backed by a fake native session into ``manager``."""

    class _Native:
        def run(self, operation):
            return operation(FakeSession(target))

        def open_rtt(self, *, control_block_address=None):
            raise NotImplementedError

        def close(self):
            pass

    managed = ManagedSession("sess-x", device_id, _Native(), None)
    manager._sessions[managed.session_id] = managed
    manager._by_device[device_id] = managed.session_id
    return managed


def test_adapter_routes_through_session_and_tracks_breakpoints():
    manager = SessionManager()
    adapter = PyOcdAdapter(manager)
    device = "pyocd:fake"
    target = FakeTarget(halted=True)
    managed = _managed_with_target(manager, device, target)

    out = adapter.set_breakpoint(device, 0x0800_0800)  # raw int address
    assert out.ok
    assert {bp["address"] for bp in managed.breakpoints} == {0x0800_0800}

    cleared = adapter.clear_breakpoint(device, 0x0800_0800)
    assert cleared.ok
    assert managed.breakpoints == []


# -- capability protocol wiring --------------------------------------------


def test_pyocd_adapter_advertises_halt_mode_capability():
    assert isinstance(PyOcdAdapter(SessionManager()), SupportsHaltModeDebug)


def test_fake_target_controller_advertises_halt_mode_capability():
    assert isinstance(FakeTargetController(), SupportsHaltModeDebug)


def test_fake_controller_full_debug_flow():
    fake = FakeTargetController()
    dev = "fake-target:0"
    assert fake.run_until(dev, "0x08000123").ok
    assert fake.read_registers(dev).ok
    assert fake.write_register(dev, "r0", 7).data["readback"] == 7
    assert fake.set_watchpoint(dev, 0x2000_0000).ok
    res = fake.list_debug_resources(dev)
    assert res.data["watchpoints_used"] == 1
