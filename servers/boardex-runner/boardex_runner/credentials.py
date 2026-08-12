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
 3. Storage is ``~/.boardex/credentials.json``, mode 0600, written atomically
    (see persistence.py). v0 kept keys in module memory and said so; this is
    the decision that limit was waiting on, and it is the boring one — an
    owner-only file in the user's home directory, the standard ``~/.netrc`` and
    ``~/.aws/credentials`` already set. Persistence changes WHERE THE DICT
    SLEEPS AND NOTHING ELSE: the same advertise()-only readable surface, the
    same hint floor, still no read-back route, and nothing on the save path
    logs a key. Encryption at rest and a shared-bench answer stay deferred —
    on a machine where another user can read your home directory, they can read
    your keys.

Env vars keep working as the fallback: a runner booted with the provider-standard
variable set is already configured (seeded at startup, so the UI sees it and does
not offer to set a key that is in fact already set), and ``resolve_key`` falls
back to the environment for anything the store does not hold. Existing setups
therefore behave exactly as they did before this module existed.

PRECEDENCE, pinned: for a given provider the FILE BEATS THE ENVIRONMENT at boot,
and the environment seeds only the providers the file says nothing about. Both
are deliberate acts, but pasting a key into the dashboard is the more recent and
more specific one — it names this runner, while an exported variable is often
inherited from a shell profile the operator has not thought about in months. The
alternative ordering would also make the dashboard silently ineffective for
anyone with the variable exported: paste, restart, and the old key is back with
nothing on screen explaining why.

What is persisted is what someone deliberately SET (``set_key``); an env seed is
never written to the file. That is what keeps the standing escape hatch true —
unset the variable, restart, and the key is gone — instead of the runner
quietly copying an exported key onto disk where it outlives the export.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

from . import persistence
from .provider import DEFAULT_MODEL

logger = logging.getLogger(__name__)

# The hint reveals at most the last four characters, and only when the key is
# long enough that four characters are a negligible fraction of it. A short key
# would have its tail be most of its material, so it masks to a bare ellipsis:
# still a truthful "something is set here", with nothing recoverable in it.
# (Same floor and same reasoning as the mock's maskKey.)
HINT_MIN_KEY_LENGTH = 8
HINT_TAIL_LENGTH = 4

# provider -> key. The EFFECTIVE store: what advertise() describes and what
# resolve_key() serves, env seeds included. Never logged.
_keys: dict[str, str] = {}
# provider -> key AS IT RESTS ON DISK: only keys someone deliberately set (or a
# previous process did). Env seeds never enter it, so unsetting the variable and
# restarting still removes the key — see the module docstring's precedence note.
# Entries for providers this runner does not know about are kept, so a runner
# booted with a narrower AGENT_MODELS cannot erase another runner's key on its
# next write.
_persisted: dict[str, str] = {}
# The providers this runner will hold a key for; derived from the advertised
# models by configure(). Empty until then, so an unconfigured process
# advertises no providers rather than guessing at one.
_providers: tuple[str, ...] = ()
# Where the store rests, resolved once per configure(). None until then.
_store_path: Path | None = None
# False until a boot has successfully READ the store (or established that it
# does not exist yet). A file we could not read is not an empty one, so this
# session must not write over it — see configure().
_persist: bool = False


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
    """The env var this store reads for ``provider``.

    ``openrouter`` -> ``OPENROUTER_API_KEY``, ``anthropic`` -> ``ANTHROPIC_API_KEY``:
    the convention followed by every provider in the DEFAULT MODEL SET, which is
    the claim this mapping actually supports — not "whatever LiteLLM reads".
    LiteLLM's own naming diverges for plenty of providers (``together_ai`` reads
    TOGETHERAI_API_KEY, not TOGETHER_AI_API_KEY; ``vertex_ai`` does not use an
    API-key variable at all), so a runner pointed at one of those gets a store
    entry that seeds from nothing and simply falls through to LiteLLM's own env
    handling — the pre-store behavior, not a break. Widening this to LiteLLM's
    real table means importing litellm here, which this module deliberately
    does not do (see provider_for_model).
    """
    return f"{provider.upper()}_API_KEY"


def _env_key(provider: str) -> str | None:
    """The environment's key for ``provider``, stripped, or None if unset/blank.

    THE single env read in this module. Seeding, re-seeding after a Remove and
    resolution all go through it, so the key the store advertises a hint for and
    the key handed to the provider are byte-identical — a stray newline in an
    exported variable cannot make advertise() and resolve_key() describe
    different keys.
    """
    value = os.environ.get(env_var_for(provider), "").strip()
    return value or None


def _models_from_env() -> list[str]:
    """AGENT_MODELS, parsed exactly as ``agent_bench.agent_models_from_env`` does.

    Duplicated (three lines) rather than imported: ``agent_bench`` pulls the
    whole agent stack, and the credential store is configured on every boot,
    including BENCH=fake where none of that is installed.
    """
    raw = os.environ.get("AGENT_MODELS", DEFAULT_MODEL)
    return [model.strip() for model in raw.split(",") if model.strip()]


def _load_persisted(path: Path) -> dict[str, str]:
    """The stored key dict, or empty when the file simply does not exist yet.

    Raises OSError for a file that exists but could not be read — including a
    path that is not a regular file. THE SYMLINK RULE lives in that
    ``no_follow``: the read refuses a symlink inside the open itself (O_NOFOLLOW
    + fstat on the descriptor, so nothing can be swapped in between deciding and
    reading), and configure() turns that refusal into a memory-only session.

    Nothing here would corrupt a link's target — ``os.replace`` swaps the LINK,
    ``rename`` moves the LINK aside — so this is not about damage. It is that a
    credentials file is only owner-only-secret if we know what it IS, and a link
    points at a file whose mode and directory we never set. Refusing costs one
    session's persistence; following costs the property the mode is there for.

    Deliberately narrow: this file, and this path — not an audit of every
    parent directory, which would be theater on a home directory the user owns.

    Non-string or blank entries are dropped individually rather than condemning
    the whole file: one hand-edited line should cost one provider's key, not
    every provider's.
    """
    raw = persistence.read_json(path, default={}, no_follow=True)
    return {
        provider: key.strip()
        for provider, key in raw.items()
        if isinstance(provider, str) and isinstance(key, str) and key.strip()
    }


def _save_persisted() -> bool:
    """Write the deliberately-set keys through, 0600 and atomically.

    False when the write did not land — including a session where persistence
    was disabled at boot, because "not written" is the same fact either way and
    the caller's decision (survivable, or must be surfaced) is the same.

    Never raises and never logs a key: persistence.write_json logs paths only.
    """
    if not _persist or _store_path is None:
        return False
    return persistence.write_json(
        _store_path, dict(_persisted), mode=persistence.OWNER_ONLY_FILE
    )


def configure(models: Sequence[str] | None = None) -> None:
    """Set the known providers from the advertised models, load the stored keys,
    and seed from env whatever the file does not cover.

    Called once at startup. ``models=None`` reads AGENT_MODELS, so the store
    knows the same providers the runner would advertise regardless of BENCH —
    the dashboard's key path has to work before anyone switches to BENCH=agent.

    Two sources, and the order between them is the ruling in the module
    docstring: the FILE first, then the environment for providers the file says
    nothing about. Seeding is what keeps env-only setups unchanged — a provider
    whose standard variable is present in the environment boots CONFIGURED, and
    the UI shows it as configured instead of offering to set a key already set.
    """
    global _providers, _store_path, _persist
    _providers = tuple(providers_from_models(models if models is not None else _models_from_env()))
    _store_path = persistence.state_dir() / persistence.CREDENTIALS_FILE
    _persisted.clear()
    _keys.clear()
    try:
        _persisted.update(_load_persisted(_store_path))
        _persist = True
    except OSError as exc:
        # An unreadable file is NOT an empty one. Persisting anything now would
        # write a store we know is incomplete over one that is probably fine —
        # a permission problem would silently become key loss. So the session
        # runs memory-only and the file is left exactly as it is, ready to work
        # again the moment whatever broke is fixed. Nothing can be resurrected
        # behind the operator's back either: the next boot reads the same file
        # the same way, and refuses it the same way.
        logger.warning(
            "could not read %s (%s); provider keys will work this session but "
            "will not persist, and the file will not be written",
            _store_path,
            exc,
        )
        _persist = False

    # PRECEDENCE, in one pass so it cannot be reordered by a later edit: the
    # file wins, and the environment is consulted only for providers the file
    # says nothing about. Splitting this into two loops would leave the ruling
    # standing on the order of two statements a hundred lines apart.
    for provider in _providers:
        stored = _persisted.get(provider)
        if stored is not None:
            _keys[provider] = stored
        else:
            from_env = _env_key(provider)
            if from_env is not None:
                _keys[provider] = from_env
    # Providers the file holds but this runner does not advertise stay in
    # _persisted — unadvertised and unresolvable here, preserved for the next
    # write so a narrower AGENT_MODELS cannot erase another launch's key.


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
    # Write-through: a key is stored the moment it is accepted, so a runner that
    # dies unexpectedly comes back with the key its 204 promised.
    #
    # A failed write does NOT fail this request, and that asymmetry with
    # delete_key is deliberate. What 204 claims here is that the key is set,
    # which is true — it is in memory and the very next run will spend it; only
    # its survival of a restart is lost, and the cost of that is pasting it
    # again. Refusing instead would take the dashboard away from anyone with a
    # read-only home directory, for a failure they can already see in the log.
    # Removal is the opposite case: there the unwritten half is a key that goes
    # on spending money, so it must be surfaced.
    _persisted[provider] = _keys[provider]
    _save_persisted()
    return None


def delete_key(provider: str) -> CredentialError | None:
    """Remove the dashboard's key, then RE-SEED from the environment if one is
    exported there. Idempotent, so Remove can be pressed twice. 500 when the
    removal could not be written to disk — see the body: a removal that only
    happened in memory is a key that comes back on the next boot and goes on
    spending, so it is reported rather than swallowed.

    Re-seeding is what keeps this store's two views from ever disagreeing. What
    Remove discards is the key the dashboard set; it cannot discard the one the
    operator exported before launch, because ``resolve_key`` would still fall
    back to it and the very next run would spend it. Leaving the slot empty
    would advertise ``configured: false`` while runs kept succeeding on the env
    key — the store telling the operator one thing and the provider layer doing
    another. So the slot goes back to exactly what boot would have put in it,
    and advertise() and resolve_key() are once again the same fact seen twice.

    The honest consequence, stated in the README: stopping spend on an
    env-provided key means unsetting the variable and restarting. That is the
    operator's launch configuration, which the dashboard deliberately has no
    authority over — a browser page must not be able to edit how the process
    was started.
    """
    if provider not in _providers:
        return CredentialError(404, "unknown provider")
    # Removal is persisted BEFORE anything is answered, and the re-seed that
    # follows is memory-only. Both halves matter: Remove must survive a restart
    # (or the next boot loads the key back out of the file and Remove was
    # theater), and the env key it falls back to must NOT be written (or
    # unsetting the variable stops helping, which is the escape hatch the
    # README promises).
    was_effective = _keys.pop(provider, None)
    was_persisted = _persisted.pop(provider, None)
    # ``_persist`` gates the check, not just the write: in a memory-only session
    # the file is not a source of truth for the NEXT boot either (the same read
    # refuses it the same way), so there is nothing a removal could fail to
    # erase and nothing to warn about.
    if was_persisted is not None and _persist and not _save_persisted():
        # The removal did not reach disk. Answering 204 here would be the
        # runner's worst available lie: the operator is told the key is gone,
        # stops thinking about it, and the next boot loads it straight back out
        # of the file and spends it. So we say so, and we put the store back
        # the way it was — a store that says "still configured" and a file that
        # holds the key are at least the same fact, and the operator can act on
        # it (fix the disk, or unset and restart).
        _keys[provider] = was_effective if was_effective is not None else was_persisted
        _persisted[provider] = was_persisted
        return CredentialError(500, "could not remove credential")
    from_env = _env_key(provider)
    if from_env is not None:
        _keys[provider] = from_env
    return None


def resolve_key(model: str) -> str | None:
    """The key to use for ``model``: store first, environment as fallback.

    Called at REQUEST time, never captured at construction — a key pasted into
    the dashboard mid-session must take effect on the next run without a
    restart, and one removed there reverts to the environment just as promptly
    (``delete_key`` re-seeds, so the store usually answers that case itself).

    The env branch reads through ``_env_key`` and is therefore stripped exactly
    as the seeded path is: both routes to the same variable must yield the same
    key, or a padded value would be advertised under one hint and sent as
    another.

    Not part of the readable surface (see the module docstring): the caller is
    the provider layer handing it to the SDK for an outbound call. Nothing that
    serves an HTTP response may call this.
    """
    provider = provider_for_model(model)
    if provider is None:
        return None
    return _keys.get(provider) or _env_key(provider)
