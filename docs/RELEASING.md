# Releasing Boardex

Backend-owner doc. A release is Python wheels + sdists on a GitHub Release,
covering **five** packages: `servers/boardex-{core,target,logic,runner}` plus
the `boardex` launcher (`boardex-app/`), whose wheel embeds the **built UI**
and the contract JSON Schema — the complete product (`pip install`, then
`boardex up`). The npm side (`apps/ui`, `packages/contract`,
`tools/mock-runner`) is the UI owner's and publishes no packages of its own;
the UI ships inside the `boardex` wheel as a built bundle (docs/decisions.md,
2026-07-29). Installers and signed desktop packaging remain deferred
(BIBLE §2.3 #7).

## Versioning model

- All five packages version in **lockstep**: one number for the whole set,
  held in [`servers/VERSION`](../servers/VERSION). A `boardex-target` wheel is
  only ever tested against the `boardex-core` wheel from the same tag, so
  per-package versions would be noise. The `boardex` launcher rides the same
  number — its published metadata pins the four siblings at `==<VERSION>`.
- Each `pyproject.toml` carries a synced static `version = "X.Y.Z"` line, and
  `boardex-app/hatch_build.py` carries the matching `SERVERS_VERSION` pin.
  Never edit those by hand — run the sync script (it covers all six files).
- Tag scheme: `servers-vX.Y.Z` (namespaced so a future contract/UI tag scheme
  can coexist).
- The wire `contractVersion` (`boardex-contract/0.1`) is a **separate** number
  owned by the contract package. A server release does not bump it and vice
  versa.

## Cutting a release

1. Make sure `main` is green (the `CI` workflow: pytest matrix on
   Linux/macOS/Windows, `npm run verify`, Playwright smoke).
2. Bump the version and sync it into the four pyprojects:

   ```bash
   echo "0.2.0" > servers/VERSION
   python servers/scripts/sync_versions.py
   git add servers/VERSION servers/*/pyproject.toml
   git commit -m "chore(servers): bump to 0.2.0"
   ```

3. Tag and push:

   ```bash
   git tag servers-v0.2.0
   git push origin main servers-v0.2.0
   ```

4. The `Release (servers)` workflow then, in order:
   - checks the tag matches `servers/VERSION` and all packages (including the
     `boardex` launcher and its sibling pins) are in lockstep
     (`sync_versions.py --check --tag ...`),
   - builds the UI bundle (`npm ci` + `npm run build -w apps/ui` with an empty
     `VITE_RUNNER_URL`, the single-origin form the wheel embeds),
   - runs the full hardware-free pytest suite (four servers + boardex-app),
   - builds wheels + sdists for all five packages (`boardex` with default —
     publishable — `==<VERSION>` sibling pins, never `file://` paths),
   - installs the wheels into a **clean venv** and smokes both a fake-bench
     `boardex-runner` (`servers/scripts/release_smoke.py`: /health contract
     check, /bench, run creation, event replay) **and** `boardex up` from the
     wheel (embedded UI served from the runner's origin),
   - publishes the GitHub Release with the artifacts and generated notes.

   If any gate fails, nothing is published — fix, delete the tag, re-tag.

## What a user does with the artifacts

Download all five wheels from the release, then:

```bash
python -m venv boardex-venv && source boardex-venv/bin/activate   # POSIX
pip install boardex*.whl
boardex up          # runner + embedded UI, one origin
boardex up --demo   # recorded run — no hardware, no API key
```

- `boardex` — the launcher: the complete app. Its wheel carries the built UI
  and a copy of the contract JSON Schema, so it needs no Node and no checkout.
- `boardex-target` / `boardex-logic` — MCP stdio servers for probes and logic
  analyzers (need pyOCD-supported hardware / a system `sigrok-cli`; see
  `docs/SUPPORT_MATRIX.md` and `boardex doctor`).
- `boardex-runner` — the §5 orchestrator, standalone. On its own it validates
  outbound events against the contract JSON Schema, which is **not** inside
  its wheel: point `BOARDEX_CONTRACT_SCHEMA_DIR` at a checkout's
  `packages/contract/json-schema/` (or run from inside a checkout, where it is
  found automatically; `boardex up` wires the bundled copy for you).

## Not covered (deliberately)

- PyPI publishing (GitHub Releases only for now).
- HIL verification in the pipeline — CI-for-hardware is deferred
  (BIBLE §2.3 #9). Live-bench proof stays a manual step
  (`servers/boardex-runner/scripts/live_run_smoke.py`).
