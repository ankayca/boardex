"""Test kit for Boardex backend adapters.

Two things live here:

- **Reference fakes** (``FakeTargetController``, ``FakeLogicAnalyzer``): full
  in-memory implementations of the domain interfaces, for testing servers and
  workflows without hardware.
- **Conformance suites** (``BackendConformance`` and friends): reusable pytest
  test classes any adapter — in-tree or third-party — subclasses to prove it
  honors the Boardex contract.

Contributor usage::

    from boardex_core.testing import TargetControllerConformance

    class TestMyJLinkAdapter(TargetControllerConformance):
        def make_adapter(self):
            return JLinkAdapter()
"""

from .conformance import (
    BackendConformance,
    LogicAnalyzerConformance,
    TargetControllerConformance,
)
from .fakes import FakeLogicAnalyzer, FakeNativeSession, FakeTargetController

__all__ = [
    "BackendConformance",
    "FakeLogicAnalyzer",
    "FakeNativeSession",
    "FakeTargetController",
    "LogicAnalyzerConformance",
    "TargetControllerConformance",
]
