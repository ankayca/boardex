"""LiteLLM provider layer for the agent bench.

Primary provider is OpenRouter (default model openrouter/anthropic/claude-sonnet-4.6,
key via OPENROUTER_API_KEY); any LiteLLM model string works with that provider's
standard env var (ANTHROPIC_API_KEY / OPENAI_API_KEY / ... for direct providers).
Keys are read from the process environment by LiteLLM at call time and nowhere
else — never logged, never stored, never on the wire. ``litellm`` itself is
imported lazily so BENCH=fake|real deployments (and the test suite) need no
agent extras installed.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

DEFAULT_MODEL = "openrouter/anthropic/claude-sonnet-4.6"

# Anthropic-style prompt caching (rides through OpenRouter unchanged). The
# request prefix is tools -> system -> messages, so a breakpoint on the system
# prompt caches the tool schemas with it — ~12k tokens re-sent on every turn
# of an agent run otherwise. A second, rolling breakpoint on the newest stable
# message caches the append-only conversation history incrementally.
CACHE_CONTROL = {"type": "ephemeral"}


def _as_cached_block(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text, "cache_control": dict(CACHE_CONTROL)}]


def with_cache_breakpoints(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a copy of ``messages`` carrying the two cache breakpoints.

    Only str-content system/user/tool messages are eligible; assistant turns
    (raw model_dump dicts) are never touched. The input list and its dicts are
    not mutated — the engine owns the running message list.
    """
    out = [dict(message) for message in messages]
    if out and out[0].get("role") == "system" and isinstance(out[0].get("content"), str):
        out[0]["content"] = _as_cached_block(out[0]["content"])
    for i in range(len(out) - 1, 0, -1):
        if out[i].get("role") in ("user", "tool") and isinstance(out[i].get("content"), str):
            out[i]["content"] = _as_cached_block(out[i]["content"])
            break
    return out


def _model_supports_prompt_caching(litellm: Any, model: str) -> bool:
    try:
        return bool(litellm.supports_prompt_caching(model))
    except Exception:
        return False


def _max_tokens_from_env() -> int | None:
    """AGENT_MAX_TOKENS caps per-request output tokens.

    Anthropic-family models require a max_tokens, and LiteLLM otherwise auto-fills
    the model's ceiling (e.g. 65536 for sonnet), which is wasteful and can trip a
    provider 402 ("requires more credits, or fewer max_tokens") on a budget-limited
    key. Unset => leave it to LiteLLM (unchanged behavior).
    """
    raw = os.environ.get("AGENT_MAX_TOKENS")
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit("AGENT_MAX_TOKENS must be an integer")
    if value <= 0:
        raise SystemExit("AGENT_MAX_TOKENS must be a positive integer")
    return value


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]
    raw_arguments: str


@dataclass
class ModelTurn:
    content: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)
    raw_message: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, int] | None = None  # per-call token usage, when the API reports it


class Provider(Protocol):
    async def complete(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> ModelTurn: ...


class MalformedToolArguments(Exception):
    """The model emitted tool-call arguments that are not valid JSON."""

    def __init__(self, tool_name: str, detail: str) -> None:
        super().__init__(detail)
        self.tool_name = tool_name


def _usage_from_response(response: Any) -> dict[str, int] | None:
    """Normalize litellm usage into flat int fields (cache detail included)."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    data = usage.model_dump() if hasattr(usage, "model_dump") else dict(usage)
    keep: dict[str, int] = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        if isinstance(data.get(key), int):
            keep[key] = data[key]
    details = data.get("prompt_tokens_details")
    if isinstance(details, dict) and isinstance(details.get("cached_tokens"), int):
        keep["cached_tokens"] = details["cached_tokens"]
    if isinstance(data.get("cache_creation_input_tokens"), int):
        keep["cache_creation_tokens"] = data["cache_creation_input_tokens"]
    return keep or None


def _parse_turn(message: Any) -> ModelTurn:
    content = getattr(message, "content", None)
    calls: list[ToolCall] = []
    for tc in getattr(message, "tool_calls", None) or []:
        raw = tc.function.arguments or "{}"
        try:
            args = json.loads(raw)
            if not isinstance(args, dict):
                raise ValueError("arguments JSON is not an object")
        except ValueError as exc:
            raise MalformedToolArguments(tc.function.name, f"{exc}: {raw[:500]}") from exc
        calls.append(ToolCall(id=tc.id, name=tc.function.name, arguments=args, raw_arguments=raw))
    raw_message = message.model_dump() if hasattr(message, "model_dump") else dict(message)
    return ModelTurn(content=content, tool_calls=calls, raw_message=raw_message)


class LiteLLMProvider:
    def __init__(self, model: str, max_tokens: int | None = None) -> None:
        self.model = model
        self.max_tokens = max_tokens if max_tokens is not None else _max_tokens_from_env()
        self._cache_prompts: bool | None = None  # resolved lazily, needs litellm

    async def complete(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> ModelTurn:
        import litellm

        litellm.suppress_debug_info = True
        if self._cache_prompts is None:
            self._cache_prompts = _model_supports_prompt_caching(litellm, self.model)
        if self._cache_prompts:
            messages = with_cache_breakpoints(messages)
        extra: dict[str, Any] = {}
        if self.max_tokens is not None:
            extra["max_tokens"] = self.max_tokens
        response = await litellm.acompletion(
            model=self.model,
            messages=messages,
            tools=tools,
            timeout=600,
            **extra,
        )
        turn = _parse_turn(response.choices[0].message)
        turn.usage = _usage_from_response(response)
        return turn
