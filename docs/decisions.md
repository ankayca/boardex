# Decision Log
2026-07-07 — Adopted docs/BIBLE.md v1.1 as source of truth for UI, contract, and mock runner. servers/ remains cofounder-owned; orchestrator service (servers/boardex-runner) will implement the §5 contract.
2026-07-07 — BIBLE v1.2: added run.iteration_started event (fix-loop iteration was unrepresentable); removed nextAction from RunSummary (UI-derived, single source); BenchStatus devices carry backend device_id.
2026-07-07 — T0.5: status-badge colors derived from D14 (§6.2 fixes risk/verdict mappings but not per-status colors): completed=green, failed/stopped=red, plan_ready/awaiting_approval/diagnosing=amber (needs the human), draft/planning/running=neutral. StatusDot: online=green, offline=amber (degraded-bench warning per §7.2), error=red.
