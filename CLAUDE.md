# CLAUDE.md — Boardex Operating Rules

This file is read at the start of every Claude Code session. It points to the one
source of truth and encodes the non-negotiable rules for working in this repo.

## Read first

- **Read `docs/BIBLE.md` before any task.** The bible is the source of truth for the
  UI, the contract, and the mock runner. When the bible and your assumptions disagree,
  **the bible wins.**

## Rules of engagement

1. **Never invent.** Do not add schema fields, event types, routes, or design tokens
   that are not defined in the bible. If something you need is missing or ambiguous,
   **STOP and ask** — do not guess.
2. **No silent dependencies.** Do not add a new dependency without listing it — and why
   it is needed — at the top of your response for that task.
3. **Scope discipline.** Implement exactly the task in front of you, nothing speculative.
   The Deferred Register (BIBLE §2.3) is off-limits: do not build, stub, or architect
   for it.
4. **Respect ownership.** `servers/` and `examples/` are the backend owner's domain.
   Read them freely; **never write** to them. The same goes for `README.md`, the
   cofounder's `docs/*.md`, and existing `.gitignore` content (extend it additively only).
5. **Prove it works.** Every task ships tests where logic exists, keeps `npm run verify`
   green (typecheck + lint + test across workspaces), and lands as atomic,
   conventionally-named commits. **If the task or review brief names a behavior to
   verify, ship the test proving it in the same commit — untested-but-correct is
   FIX_FIRST by default.**
6. **Reviews always end with the §9.2 merge report block:** Verdict / Findings /
   Checks line — regardless of what format the workflow tooling emits.

## Color semantics (BIBLE §6.1 / D14) — reserved, never decorative

- **Green** = pass / success **only**.
- **Red** = fail / stop **only**.
- **Amber** = approval-needed / warning **only**.

One accent color for actions. No gradients, no glassmorphism, no dark mode in MVP.

## Repo shape (BIBLE §3)

npm workspaces cover `packages/*`, `apps/*`, and `tools/*` only. `servers/` is
Python-land and invisible to npm. `apps/ui` and `tools/mock-runner` both import
`packages/contract`; nothing imports from `apps/ui`. TypeScript never imports from
`servers/` — the emitted JSON Schema in `packages/contract/json-schema/` is the only
cross-language bridge.

## Commands

- `npm run dev` — run the UI and the mock runner concurrently.
- `npm run verify` — typecheck + lint + test across all workspaces (must be green).
- `npm run test` — tests across all workspaces.
