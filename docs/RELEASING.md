# Releasing the Boardex server packages

Backend-owner doc. Covers `servers/boardex-{core,target,logic,runner}` only —
the npm side (`apps/ui`, `packages/contract`, `tools/mock-runner`) is the UI
owner's and has no release pipeline here. Installers and signed desktop
packaging remain deferred (BIBLE §2.3 #7); a release is Python wheels + sdists
on a GitHub Release.

## Versioning model

- The four server packages version in **lockstep**: one number for the whole
  set, held in [`servers/VERSION`](../servers/VERSION). A `boardex-target`
  wheel is only ever tested against the `boardex-core` wheel from the same
  tag, so per-package versions would be noise.
- Each `pyproject.toml` carries a synced static `version = "X.Y.Z"` line.
  Never edit those by hand — run the sync script.
- Tag scheme: `servers-vX.Y.Z` (namespaced so a future contract/UI tag scheme
  can coexist).
- The wire `contractVersion` (`boardex-contract/0.1`) is a **separate** number
  owned by the contract package. A server release does not bump it and vice
  versa.

## Cutting a release

1. Make sure `main` is green (the `CI` workflow: pytest matrix on
   Linux/macOS/Windows, `npm run verify`, firmware examples).
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
   - checks the tag matches `servers/VERSION` and the pyprojects are in
     lockstep (`sync_versions.py --check --tag ...`),
   - runs the full hardware-free pytest suite,
   - builds wheels + sdists for all four packages,
   - installs the wheels into a **clean venv** and smokes a fake-bench
     `boardex-runner` from them (`servers/scripts/release_smoke.py`: /health
     contract check, /bench, run creation, event replay),
   - publishes the GitHub Release with the artifacts and generated notes.

   If any gate fails, nothing is published — fix, delete the tag, re-tag.

## What a user does with the artifacts

Download all four wheels from the release, then:

```bash
python -m venv boardex-venv && source boardex-venv/bin/activate   # POSIX
pip install boardex_*.whl
```

- `boardex-target` / `boardex-logic` — MCP stdio servers for probes and logic
  analyzers (need pyOCD-supported hardware / a system `sigrok-cli`; see
  `docs/SUPPORT_MATRIX.md` and `boardex-doctor`).
- `boardex-runner` — the §5 orchestrator. It validates outbound events against
  the contract JSON Schema, which is **not** inside the wheels: point
  `BOARDEX_CONTRACT_SCHEMA_DIR` at a checkout's
  `packages/contract/json-schema/` (or run from inside a checkout, where it is
  found automatically).

## Not covered (deliberately)

- PyPI publishing (GitHub Releases only for now).
- HIL verification in the pipeline — CI-for-hardware is deferred
  (BIBLE §2.3 #9). Live-bench proof stays a manual step
  (`servers/boardex-runner/scripts/live_run_smoke.py`).
