"""LiteLLMProvider config wiring (no network, no litellm import needed)."""

from __future__ import annotations

import json
import logging
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
    """Stands in for litellm in sys.modules: captures the acompletion request.

    Mirrors the real 1.92.0 surface the provider depends on — ``utils`` and
    ``exceptions`` submodules, ``get_llm_provider`` resolution — so a fake that
    drifts from the real API cannot make these tests pass while production
    breaks (which is exactly how the top-level-attribute bug survived)."""

    def __init__(self, supports_caching: bool, provider: str = "openrouter",
                 resolved: str = "anthropic/claude-sonnet-4.6") -> None:
        super().__init__("litellm")
        self.suppress_debug_info = False
        self._supports = supports_caching
        self._provider = provider
        self._resolved = resolved
        self.captured: dict[str, Any] = {}
        import litellm.exceptions

        self.exceptions = litellm.exceptions
        self.utils = types.SimpleNamespace(
            supports_prompt_caching=lambda model, **kw: self._supports
        )

    def get_llm_provider(self, model: str, **kwargs: Any) -> tuple[str, str, None, None]:
        return self._resolved, self._provider, None, None

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


def _complete(  # type: ignore[no-untyped-def]
    monkeypatch,
    supports_caching: bool,
    model: str = "openrouter/anthropic/claude-sonnet-4.6",
    provider_name: str = "openrouter",
    resolved: str = "anthropic/claude-sonnet-4.6",
):
    import asyncio

    fake = _FakeLiteLLM(supports_caching, provider=provider_name, resolved=resolved)
    monkeypatch.setitem(sys.modules, "litellm", fake)
    provider = LiteLLMProvider(model, max_tokens=1024)
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


def test_non_anthropic_model_gets_a_byte_identical_pre_branch_request(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """F2: OpenAI models report supports_prompt_caching=True (their caching is
    automatic and server-side) but reject Anthropic-style cache_control blocks.
    The provider family gates the injection, so the request is untouched."""
    captured, _ = _complete(
        monkeypatch,
        supports_caching=True,  # as the real litellm reports for gpt-4o-mini
        model="gpt-4o-mini",
        provider_name="openai",
        resolved="gpt-4o-mini",
    )
    assert captured["messages"] == _agent_messages()
    assert not any(
        "cache_control" in json.dumps(m, default=str) for m in captured["messages"]
    )


def test_unresolvable_model_disables_caching_without_raising(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """The unknown-model lookup miss is the one swallowed case."""
    import litellm.exceptions

    fake = _FakeLiteLLM(supports_caching=True)

    def boom(model: str, **kwargs: Any) -> Any:
        raise litellm.exceptions.BadRequestError(
            message="LLM Provider NOT provided", model=model, llm_provider="unknown"
        )

    fake.get_llm_provider = boom  # type: ignore[method-assign]
    monkeypatch.setitem(sys.modules, "litellm", fake)
    provider = LiteLLMProvider("totally/unknown-model-xyz")
    import asyncio

    asyncio.run(provider.complete(_agent_messages(), tools=[]))
    assert fake.captured["messages"] == _agent_messages()


def test_a_renamed_litellm_helper_surfaces_instead_of_silently_disabling(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """F1's root cause: the original gate caught bare Exception, so calling a
    helper that did not exist degraded to uncached requests in silence. An
    AttributeError here is a wiring bug and must reach the operator."""
    fake = _FakeLiteLLM(supports_caching=True)
    del fake.utils  # simulate the helper moving again
    monkeypatch.setitem(sys.modules, "litellm", fake)
    provider = LiteLLMProvider("openrouter/anthropic/claude-sonnet-4.6")
    import asyncio

    with pytest.raises(AttributeError):
        asyncio.run(provider.complete(_agent_messages(), tools=[]))


def test_disabled_caching_on_an_anthropic_shaped_model_warns(monkeypatch, caplog) -> None:  # type: ignore[no-untyped-def]
    """Silent degradation on an Anthropic model is the exact failure this
    branch exists to prevent — it must be loud."""
    with caplog.at_level(logging.WARNING, logger="boardex_runner.provider"):
        _complete(
            monkeypatch,
            supports_caching=False,
            model="openrouter/anthropic/claude-sonnet-4.6",
        )
    assert "prompt caching DISABLED" in caplog.text
    assert "openrouter/anthropic/claude-sonnet-4.6" in caplog.text


def test_non_anthropic_model_disabling_caching_stays_quiet(monkeypatch, caplog) -> None:  # type: ignore[no-untyped-def]
    with caplog.at_level(logging.WARNING, logger="boardex_runner.provider"):
        _complete(
            monkeypatch,
            supports_caching=True,
            model="gpt-4o-mini",
            provider_name="openai",
            resolved="gpt-4o-mini",
        )
    assert caplog.text == ""  # expected and uninteresting — not a warning


# -- the real litellm (local model DB, no network) -------------------------------


def test_default_model_really_resolves_to_caching_enabled() -> None:
    """The reviewer's prescribed pin: exercise the gate against the REAL
    litellm, so a helper that moves or a model DB that drops the capability
    fails here instead of silently costing money on the next hardware run."""
    import litellm

    from boardex_runner.provider import DEFAULT_MODEL, _model_supports_prompt_caching

    assert _model_supports_prompt_caching(litellm, DEFAULT_MODEL) is True


def test_real_litellm_gate_rejects_a_non_anthropic_model() -> None:
    import litellm

    from boardex_runner.provider import _model_supports_prompt_caching

    # Real litellm reports supports_prompt_caching=True here; the family check
    # is what keeps cache_control off an OpenAI request.
    assert litellm.utils.supports_prompt_caching("gpt-4o-mini") is True
    assert _model_supports_prompt_caching(litellm, "gpt-4o-mini") is False


def test_usage_is_captured_flat_including_cache_detail(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    _, turn = _complete(monkeypatch, supports_caching=True)
    assert turn.usage == {
        "prompt_tokens": 4000,
        "completion_tokens": 120,
        "total_tokens": 4120,
        "cached_tokens": 3800,
        "cache_creation_tokens": 150,
    }
