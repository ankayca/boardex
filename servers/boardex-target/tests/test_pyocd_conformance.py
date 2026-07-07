"""Run the built-in pyOCD adapter through the shared conformance suite.

Hardware-free: contract checks only (typed errors, result shapes, namespaced
ids). Contributors adding new probe backends should copy this pattern.
"""

from __future__ import annotations

from boardex_core.testing import TargetControllerConformance
from boardex_target.adapters.pyocd_adapter import PyOcdAdapter
from boardex_target.session import SessionManager


class TestPyOcdAdapterConformance(TargetControllerConformance):
    def make_adapter(self) -> PyOcdAdapter:
        return PyOcdAdapter(SessionManager())
