"""Provider credentials: the write-only key store behind ``PUT /credentials``,
``DELETE /credentials/{provider}`` and ``/health``'s ``credentials`` field.

Ported from the mock runner's reference implementation (``tools/mock-runner/
src/credentials.ts``), which prototyped this as a §10.5 proposal — see
docs/decisions.md, 2026-07-28. It is NOT a contract addition: ``HealthResponse``
is unchanged and a plain-object parse STRIPS the field, so the UI feature-detects
the capability off ``/health`` rather than probing the routes.

Why it exists: keys were env-only, which is an adoption wall. A new user with no
key got a failed run with the reason buried in the agent log, and the fix
required a terminal, an exported variable and a runner restart. With this store
the dashboard is the primary path and nobody has to touch a shell to set a key.

SECRETS DISCIPLINE — this is the design, not a precaution bolted on:

 1. WRITE-ONLY over HTTP. ``advertise()`` is this module's ENTIRE readable
    surface for anything that serves a response: it returns presence plus a
    masked hint, never key material. There is deliberately no read-back route
    and NONE MAY EVER BE ADDED — the property that a key cannot be exfiltrated
    from this process rests on there being nothing that serves it back, not on
    the current routes happening to be careful. The first read-back route added
    (even "just for debugging", even localhost-only) undoes all of it, because
    every other guarantee here is downstream of "nothing reads keys out".
    ``resolve_key()`` is the single exception and is not part of that surface:
    it hands the key straight to the provider SDK on an outbound API call, is
    reachable from no route, and must stay that way.
 2. The key never reaches an event, an artifact, a log line or an error body.
    This module is not wired to the event log at all, and every rejection below
    answers with a FIXED string that never echoes the request.
 3. Storage is module memory: it dies with the process. Honest for v0 — a key
    that survives a restart needs a decision about where it rests on disk, and
    inventing one here would put secrets somewhere nobody chose.

Env vars keep working as the fallback: a runner booted with the provider-standard
variable set is already configured (seeded at startup, so the UI sees it and does
not offer to set a key that is in fact already set), and ``resolve_key`` falls
back to the environment for anything the store does not hold. Existing setups
therefore behave exactly as they did before this module existed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from .provider import DEFAULT_MODEL

# The hint reveals at most the last four characters, and only when the key is
# long enough that four characters are a negligible fraction of it. A short key
# would have its tail be most of its material, so it masks to a bare ellipsis:
# still a truthful "something is set here", with nothing recoverable in it.
# (Same floor and same reasoning as the mock's maskKey.)
HINT_MIN_KEY_LENGTH = 8
HINT_TAIL_LENGTH = 4

# provider -> key. Module memory only; never serialized, never logged.
_keys: dict[str, str] = {}
# The providers this runner will hold a key for; derived from the advertised
# models by configure(). Empty until then, so an unconfigured process
# advertises no providers rather than guessing at one.
_providers: tuple[str, ...] = ()


@dataclass(frozen=True)
class CredentialError:
    """A rejection with the status the route should answer. ``error`` is always
    a fixed string — it never carries any part of the submitted request."""

    status: int
    error: str


def mask_key(key: str) -> str:
    """The masked hint: last ``HINT_TAIL_LENGTH`` chars, nothing for short keys."""
    if len(key) >= HINT_MIN_KEY_LENGTH:
        return f"…{key[-HINT_TAIL_LENGTH:]}"
    return "…"


def provider_for_model(model: str) -> str | None:
    """The provider a LiteLLM model string names, or None.

    Derivation is the prefix before the first slash
    (``openrouter/anthropic/claude-sonnet-4.6`` -> ``openrouter``), the same
    rule the UI's pre-flight uses. A BARE model string derives NOTHING: naming
    its provider needs LiteLLM's provider tables (``litellm.get_llm_provider``),
    and litellm is an optional extra imported lazily at call time — resolving it
    here would drag the agent extras into every fake-bench boot. An underivable
    model simply has no store entry and falls through to the environment, which
    is exactly the pre-store behavior.
    """
    prefix, slash, _rest = model.partition("/")
    return prefix if slash and prefix else None


def providers_from_models(models: Iterable[str]) -> list[str]:
    """Advertised models -> the ordered, deduped providers they name."""
    out: list[str] = []
    for model in models:
        provider = provider_for_model(model.strip())
        if provider is not None and provider not in out:
            out.append(provider)
    return out


def env_var_for(provider: str) -> str:
    """The provider-standard env var LiteLLM reads for ``provider``.

    ``openrouter`` -> ``OPENROUTER_API_KEY``, ``anthropic`` -> ``ANTHROPIC_API_KEY``,
    and so on — the convention every provider in the default model set follows,
    so the mapping generalizes with AGENT_MODELS instead of hardcoding one name.
    """
    return f"{provider.upper()}_API_KEY"


def _models_from_env() -> list[str]:
    """AGENT_MODELS, parsed exactly as ``agent_bench.agent_models_from_env`` does.

    Duplicated (three lines) rather than imported: ``agent_bench`` pulls the
    whole agent stack, and the credential store is configured on every boot,
    including BENCH=fake where none of that is installed.
    """
    raw = os.environ.get("AGENT_MODELS", DEFAULT_MODEL)
    return [model.strip() for model in raw.split(",") if model.strip()]


def configure(models: Sequence[str] | None = None) -> None:
    """Set the known providers from the advertised models and seed from env.

    Called once at startup. ``models=None`` reads AGENT_MODELS, so the store
    knows the same providers the runner would advertise regardless of BENCH —
    the dashboard's key path has to work before anyone switches to BENCH=agent.

    Seeding is what keeps env-only setups unchanged: a provider whose standard
    variable is present in the environment boots CONFIGURED, and the UI shows it
    as configured instead of offering to set a key that is already set.
    """
    global _providers
    _providers = tuple(providers_from_models(models if models is not None else _models_from_env()))
    _keys.clear()
    for provider in _providers:
        from_env = os.environ.get(env_var_for(provider), "").strip()
        if from_env:
            _keys[provider] = from_env


def known_providers() -> tuple[str, ...]:
    """The providers this runner can hold a key for (no key material)."""
    return _providers


def advertise() -> list[dict[str, Any]]:
    """The ONLY outward view of this store: presence + hint, per provider."""
    out: list[dict[str, Any]] = []
    for provider in _providers:
        key = _keys.get(provider)
        if key is None:
            out.append({"provider": provider, "configured": False})
        else:
            out.append({"provider": provider, "configured": True, "hint": mask_key(key)})
    return out


def set_key(provider: Any, api_key: Any) -> CredentialError | None:
    """Store a key for a known provider. None on success.

    Identity is checked before the payload: a key sent at a provider this runner
    does not have is a 404 about the ROUTE, and answering 400 there would tell
    the caller their key was malformed when it was not.
    """
    if not isinstance(provider, str) or provider not in _providers:
        # Every rejection string here is FIXED — it never echoes the request
        # body, so a mistyped key cannot end up in a response, a proxy log or a
        # UI toast.
        return CredentialError(404, "unknown provider")
    if not isinstance(api_key, str) or not api_key.strip():
        return CredentialError(400, "invalid api key")
    _keys[provider] = api_key.strip()
    return None


def delete_key(provider: str) -> CredentialError | None:
    """Remove a provider's key. Idempotent: a known provider with no key is a
    success, so the dashboard's Remove can be pressed twice."""
    if provider not in _providers:
        return CredentialError(404, "unknown provider")
    _keys.pop(provider, None)
    return None


def resolve_key(model: str) -> str | None:
    """The key to use for ``model``: store first, environment as fallback.

    Called at REQUEST time, never captured at construction — a key pasted into
    the dashboard mid-session must take effect on the next run without a
    restart, and one removed there must stop being used just as promptly.

    Not part of the readable surface (see the module docstring): the caller is
    the provider layer handing it to the SDK for an outbound call. Nothing that
    serves an HTTP response may call this.
    """
    provider = provider_for_model(model)
    if provider is None:
        return None
    stored = _keys.get(provider)
    if stored:
        return stored
    return os.environ.get(env_var_for(provider)) or None
