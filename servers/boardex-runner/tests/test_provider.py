"""LiteLLMProvider config wiring (no network, no litellm import needed)."""

from __future__ import annotations

import pytest

from boardex_runner.provider import LiteLLMProvider, _max_tokens_from_env


def test_max_tokens_unset_leaves_it_to_litellm(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("AGENT_MAX_TOKENS", raising=False)
    assert _max_tokens_from_env() is None
    assert LiteLLMProvider("openrouter/anthropic/claude-sonnet-4.6").max_tokens is None


def test_max_tokens_read_from_env(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("AGENT_MAX_TOKENS", "8192")
    assert _max_tokens_from_env() == 8192
    assert LiteLLMProvider("m").max_tokens == 8192


def test_explicit_max_tokens_overrides_env(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("AGENT_MAX_TOKENS", "8192")
    assert LiteLLMProvider("m", max_tokens=4096).max_tokens == 4096


def test_invalid_max_tokens_fails_fast(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("AGENT_MAX_TOKENS", "not-a-number")
    with pytest.raises(SystemExit):
        _max_tokens_from_env()
    monkeypatch.setenv("AGENT_MAX_TOKENS", "0")
    with pytest.raises(SystemExit):
        _max_tokens_from_env()
