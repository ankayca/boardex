# Security Policy

## Supported versions

Boardex is pre-1.0. Only the latest release is supported; fixes go out in a new 0.x
release rather than being backported.

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest 0.x release | ✅                 |
| Anything older     | ❌ — upgrade first |

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting: the **Security** tab of this repository →
**Report a vulnerability**. It gets the report to the maintainers privately and gives us
a place to work with you on a fix.

If that is unavailable to you for any reason, email **kerem@humanxsystems.com** instead.

That address is monitored by the maintainers, and reports sent to it get a best-effort
response.

Useful things to include, roughly in order of value:

- what an attacker can do, and what they need in order to do it (local user? another
  program on the same machine? a web page the user visits? a device on the network?)
- the smallest reproduction you have — a request, a profile, a file path, a run
- the version (`boardex --version`) and the OS
- `boardex doctor` output, if the machine's configuration is relevant
- if a run was involved and you can share it, a recording folder (`RECORD=<dir>`), which
  contains the complete run

## What counts as a security issue here

Boardex runs on an engineer's machine, holds a model provider key, edits and builds real
code, and drives hardware. The things we care most about, concretely:

- **Provider key handling.** A key you set is held in memory for the session and is
  write-only: no route serves it back, it is not written to disk, and it is not stored in
  the browser. Any path that gets a key out — into an event, an artifact, a log line, an
  error body, a recording, a crash dump — is a vulnerability, not a cosmetic bug.
- **The localhost trust boundary.** The runner is meant to be reached from the machine it
  runs on. Credential routes require a loopback host specifically as a defense against a
  malicious web page rebinding DNS to reach them. Anything that lets a remote origin, a
  page in the user's browser, or another user on the same host reach a privileged route —
  or that widens the boundary beyond what the launch flags asked for — is in scope.
- **Traversal in served content.** The runner serves the dashboard and the artifacts a
  run produced. A request that escapes those roots and reads something else on disk is in
  scope, including via symlinks, encoded separators, and archive members.
- **Anything that makes the runner act without its gates.** Approvals are the product's
  central safety property: nothing that touches hardware — flashing, resetting — may
  happen while an approval is unresolved, a rejection must end the run with the tool
  provably never called, and a stop must actually stop. A code path that flashes without
  a resolved approval, or that resolves an approval on the user's behalf, is a
  vulnerability even if nobody could exploit it remotely. The same goes for anything that
  gets the agent to execute commands or edit files outside the workspace it was pointed
  at.

**What is not an issue:** Boardex, by design, executes builds and edits files on the
machine it runs on, under a plan you approved. That is the product, not a sandbox escape.
Also not issues: the fabricated credentials in the test suite (they are deliberate
needles used by tests that grep for leaks — they open nothing), and choosing to bind
beyond loopback yourself with an explicit flag.

If you are not sure whether something qualifies, report it. We would rather read a
report that turns out to be a normal bug than not hear about a real one.

## What to expect from us

Honest version: this is early software maintained by a small team, and we are not going
to promise a response time we cannot keep.

- We will acknowledge your report as soon as we see it, and tell you whether we consider
  it a security issue.
- Serious issues get worked on ahead of features.
- If a fix is going to take a while, we will say so rather than going quiet.
- We will credit you when we fix it, unless you would rather we did not.

Please give us a reasonable window to ship a fix before disclosing publicly. If we have
gone silent on you, that window has expired.
