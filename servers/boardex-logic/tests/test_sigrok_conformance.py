"""Run the built-in sigrok adapter through the shared conformance suite.

Hardware-free: contract checks only (typed errors, result shapes, namespaced
ids). Contributors adding new analyzer backends should copy this pattern.
"""

from __future__ import annotations

from boardex_core.testing import LogicAnalyzerConformance
from boardex_logic.adapters.sigrok_adapter import SigrokAdapter


class TestSigrokAdapterConformance(LogicAnalyzerConformance):
    def make_adapter(self) -> SigrokAdapter:
        return SigrokAdapter()
