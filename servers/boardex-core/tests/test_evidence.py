"""Tests for shared evidence types."""

from __future__ import annotations

from boardex_core import Verdict, combine_verdicts


def test_combine_verdicts_worst_wins():
    assert combine_verdicts(Verdict.PASS, Verdict.FAIL) == Verdict.FAIL
    assert combine_verdicts(Verdict.PASS, Verdict.ERROR) == Verdict.ERROR
    assert combine_verdicts(Verdict.INCONCLUSIVE, Verdict.PASS) == Verdict.INCONCLUSIVE
