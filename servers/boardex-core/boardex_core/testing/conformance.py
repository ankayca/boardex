"""Reusable conformance suites: prove an adapter honors the Boardex contract.

A contributor writing a new backend adapter subclasses the suite matching
their domain and implements ``make_adapter()``::

    from boardex_core.testing import TargetControllerConformance

    class TestMyJLinkAdapter(TargetControllerConformance):
        def make_adapter(self):
            return JLinkAdapter()

Every test here is hardware-free: it asserts the *contract* (typed errors,
``OperationResult`` returns, stable namespaced device ids, non-raising
``scan()``), not device behavior. Device-level checks run only when the
adapter actually reports hardware.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from ..errors import BoardexError
from ..interfaces import Backend, DeviceInfo, LogicAnalyzer, TargetController
from ..results import OperationResult, Verdict

_VALID_VERDICTS = {v.value for v in Verdict}


class BackendConformance:
    """Contract checks every backend adapter must pass, regardless of domain."""

    def make_adapter(self) -> Backend:
        raise NotImplementedError("Subclass must return the adapter under test.")

    # -- helpers -------------------------------------------------------------

    def _assert_contract_outcome(self, fn: Callable[[], Any]) -> None:
        """An operation must return an OperationResult or raise a typed error.

        What it must never do is leak a random vendor exception across the
        facade boundary.
        """
        try:
            result = fn()
        except BoardexError:
            return
        assert isinstance(result, OperationResult), (
            f"Expected OperationResult or BoardexError, got {type(result).__name__}"
        )
        assert result.verdict.value in _VALID_VERDICTS

    # -- tests ---------------------------------------------------------------

    def test_backend_name_is_stable_identifier(self) -> None:
        adapter = self.make_adapter()
        assert isinstance(adapter.backend_name, str)
        assert adapter.backend_name not in ("", "abstract")
        assert adapter.backend_name == adapter.backend_name.strip()

    def test_is_available_returns_bool(self) -> None:
        assert isinstance(self.make_adapter().is_available(), bool)

    def test_scan_never_raises_and_is_well_formed(self) -> None:
        adapter = self.make_adapter()
        devices = adapter.scan()
        assert isinstance(devices, list)
        for dev in devices:
            assert isinstance(dev, DeviceInfo)
            # Namespaced, stable ids: "<backend_name>:<something>".
            assert dev.device_id.startswith(f"{adapter.backend_name}:"), (
                f"device_id {dev.device_id!r} is not namespaced by backend name"
            )
            assert dev.backend == adapter.backend_name
            # The descriptor must serialise cleanly across the MCP boundary.
            json.dumps(dev.to_dict())

    def test_operation_result_serialises(self) -> None:
        # Sanity-check the shared result type the adapter is expected to emit.
        result = OperationResult.passed("ok", value=1)
        payload = result.to_dict()
        assert payload["verdict"] == "pass"
        json.dumps(payload)


class TargetControllerConformance(BackendConformance):
    """Contract checks for flash/debug backends (``TargetController``)."""

    UNKNOWN_DEVICE = "conformance:no-such-device"

    def make_adapter(self) -> TargetController:
        raise NotImplementedError("Subclass must return the adapter under test.")

    def test_implements_target_controller(self) -> None:
        assert isinstance(self.make_adapter(), TargetController)

    def test_unknown_device_fails_typed_not_raw(self) -> None:
        adapter = self.make_adapter()
        self._assert_contract_outcome(
            lambda: adapter.flash(self.UNKNOWN_DEVICE, "/nonexistent.elf")
        )
        self._assert_contract_outcome(lambda: adapter.reset(self.UNKNOWN_DEVICE))
        self._assert_contract_outcome(
            lambda: adapter.read_memory(self.UNKNOWN_DEVICE, 0x2000_0000, 4)
        )
        self._assert_contract_outcome(lambda: adapter.get_status(self.UNKNOWN_DEVICE))


class LogicAnalyzerConformance(BackendConformance):
    """Contract checks for logic-analyzer backends (``LogicAnalyzer``)."""

    UNKNOWN_DEVICE = "conformance:no-such-device"

    def make_adapter(self) -> LogicAnalyzer:
        raise NotImplementedError("Subclass must return the adapter under test.")

    def test_implements_logic_analyzer(self) -> None:
        assert isinstance(self.make_adapter(), LogicAnalyzer)

    def test_unknown_device_fails_typed_not_raw(self) -> None:
        adapter = self.make_adapter()
        self._assert_contract_outcome(
            lambda: adapter.capabilities(self.UNKNOWN_DEVICE)
        )
        self._assert_contract_outcome(
            lambda: adapter.capture(self.UNKNOWN_DEVICE, num_samples=8)
        )

    def test_decode_default_is_inconclusive_not_crash(self) -> None:
        adapter = self.make_adapter()
        self._assert_contract_outcome(
            lambda: adapter.decode(self.UNKNOWN_DEVICE, "i2c", {"scl": 0, "sda": 1})
        )
