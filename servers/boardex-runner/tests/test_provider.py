"""LiteLLMProvider config wiring (no network, no litellm import needed)."""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

from boardex_runner.provider import (
    LiteLLMProvider,
    _max_tokens_from_env,
    with_cache_breakpoints,
)


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


# -- prompt caching -------------------------------------------------------------


def _agent_messages() -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "You are the bench agent."},
        {"role": "user", "content": "## Task\nBring up the sensor."},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"result": "ok"}'},
    ]


def test_cache_breakpoints_mark_system_and_newest_stable_message() -> None:
    messages = _agent_messages()
    marked = with_cache_breakpoints(messages)

    assert marked[0]["content"] == [
        {
            "type": "text",
            "text": "You are the bench agent.",
            "cache_control": {"type": "ephemeral"},
        }
    ]
    # The rolling breakpoint lands on the newest user/tool message only.
    assert marked[3]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert marked[1]["content"] == "## Task\nBring up the sensor."
    # Assistant turns (raw model_dump dicts) are never touched.
    assert marked[2] == messages[2]
    # Exactly two breakpoints per request (Anthropic allows at most four).
    rendered = [
        part
        for m in marked
        if isinstance(m.get("content"), list)
        for part in m["content"]
        if "cache_control" in part
    ]
    assert len(rendered) == 2


def test_cache_breakpoints_do_not_mutate_the_engine_message_list() -> None:
    messages = _agent_messages()
    with_cache_breakpoints(messages)
    assert messages == _agent_messages()


def test_cache_breakpoints_without_system_message_only_mark_the_tail() -> None:
    messages = _agent_messages()[1:]
    marked = with_cache_breakpoints(messages)
    assert marked[0]["content"] == "## Task\nBring up the sensor."  # index 0 never marked
    assert marked[2]["content"][0]["cache_control"] == {"type": "ephemeral"}


class _FakeLiteLLM(types.ModuleType):
    """Stands in for litellm in sys.modules: captures the acompletion request."""

    def __init__(self, supports_caching: bool) -> None:
        super().__init__("litellm")
        self.suppress_debug_info = False
        self._supports = supports_caching
        self.captured: dict[str, Any] = {}

    def supports_prompt_caching(self, model: str) -> bool:
        return self._supports

    async def acompletion(self, **kwargs: Any) -> Any:
        self.captured = kwargs
        message = types.SimpleNamespace(
            content="ok", tool_calls=None, model_dump=lambda: {"role": "assistant", "content": "ok"}
        )
        usage = {
            "prompt_tokens": 4000,
            "completion_tokens": 120,
            "total_tokens": 4120,
            "prompt_tokens_details": {"cached_tokens": 3800},
            "cache_creation_input_tokens": 150,
        }
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=message)], usage=usage
        )


def _complete(monkeypatch, supports_caching: bool):  # type: ignore[no-untyped-def]
    import asyncio

    fake = _FakeLiteLLM(supports_caching)
    monkeypatch.setitem(sys.modules, "litellm", fake)
    provider = LiteLLMProvider("openrouter/anthropic/claude-sonnet-4.6", max_tokens=1024)
    turn = asyncio.run(provider.complete(_agent_messages(), tools=[]))
    return fake.captured, turn


def test_request_carries_cache_control_when_model_supports_caching(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    captured, _ = _complete(monkeypatch, supports_caching=True)
    sent = captured["messages"]
    assert sent[0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert sent[3]["content"][0]["cache_control"] == {"type": "ephemeral"}


def test_request_is_untouched_when_model_lacks_caching(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    captured, _ = _complete(monkeypatch, supports_caching=False)
    assert captured["messages"] == _agent_messages()


def test_usage_is_captured_flat_including_cache_detail(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _, turn = _complete(monkeypatch, supports_caching=True)
    assert turn.usage == {
        "prompt_tokens": 4000,
        "completion_tokens": 120,
        "total_tokens": 4120,
        "cached_tokens": 3800,
        "cache_creation_tokens": 150,
    }
