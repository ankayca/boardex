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


class Provider(Protocol):
    async def complete(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> ModelTurn: ...


class MalformedToolArguments(Exception):
    """The model emitted tool-call arguments that are not valid JSON."""

    def __init__(self, tool_name: str, detail: str) -> None:
        super().__init__(detail)
        self.tool_name = tool_name


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

    async def complete(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> ModelTurn:
        import litellm

        litellm.suppress_debug_info = True
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
        return _parse_turn(response.choices[0].message)
