"""LiteLLM provider layer.

Primary provider is OpenRouter (default model openrouter/anthropic/claude-sonnet-4.6,
key via OPENROUTER_API_KEY); any LiteLLM model string works with that provider's
standard env var. One probe call at startup fails loudly on a missing/invalid
key or an unrecognized model — never mid-run.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol

DEFAULT_MODEL = "openrouter/anthropic/claude-sonnet-4.6"


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
    async def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelTurn: ...


class ProviderStartupError(Exception):
    """The model/key combination is unusable; refuse to start the run."""


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
    def __init__(self, model: str) -> None:
        self.model = model

    def probe(self) -> None:
        """One tiny synchronous completion; raises ProviderStartupError on any failure."""
        import litellm

        litellm.suppress_debug_info = True
        try:
            litellm.completion(
                model=self.model,
                messages=[{"role": "user", "content": "Reply with the single word OK."}],
                max_tokens=8,
                timeout=60,
            )
        except Exception as exc:  # noqa: BLE001 — every failure here must halt startup
            raise ProviderStartupError(
                f"startup probe against model {self.model!r} failed: "
                f"{type(exc).__name__}: {exc}\n"
                "Check the model string and the provider API key "
                "(OPENROUTER_API_KEY for openrouter/* models; ANTHROPIC_API_KEY / "
                "OPENAI_API_KEY / ... for direct providers)."
            ) from exc

    async def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelTurn:
        import litellm

        response = await litellm.acompletion(
            model=self.model,
            messages=messages,
            tools=tools,
            timeout=600,
        )
        return _parse_turn(response.choices[0].message)
