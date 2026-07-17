"""agent-spike CLI.

    agent-spike --task "<prompt>" --repo <path> --model <litellm-model> \
                --record <dir> [--max-turns N] [--max-iterations N]

Startup order: provider probe (fail loud) -> recorder -> plan phase; the MCP
servers are spawned only after plan approval (spec §2: unapproved hardware
access is unrepresentable).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

from .contract import find_repo_root
from .loop import Harness, RunConfig
from .mcp_client import McpHostError, McpToolHost
from .provider import DEFAULT_MODEL, LiteLLMProvider, ProviderStartupError
from .recorder import RunRecorder
from .workspace import Workspace


def stdin_approver(prompt_text: str) -> bool:
    print(f"\n=== {prompt_text}", flush=True)
    while True:
        answer = input("[y/n] > ").strip().lower()
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        print("Answer y or n.", flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-spike", description=__doc__)
    parser.add_argument("--task", required=True, help="Task prompt for the agent")
    parser.add_argument("--repo", required=True, type=Path, help="Task repo the agent may edit")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"LiteLLM model string (default {DEFAULT_MODEL})")
    parser.add_argument("--record", required=True, type=Path, help="Directory for recorded_run.jsonl + artifacts/")
    parser.add_argument("--max-turns", type=int, default=40)
    parser.add_argument("--max-iterations", type=int, default=3)
    return parser


async def _amain(args: argparse.Namespace) -> int:
    repo_root = find_repo_root()
    run_id = "run_spike_" + datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    recorder = RunRecorder(args.record, run_id, repo_root)
    workspace = Workspace(args.repo)
    provider = LiteLLMProvider(args.model)

    mcp_host = McpToolHost()

    async def bind_mcp():
        try:
            await mcp_host.connect(repo_root)
            print(
                f"[agent-spike] MCP bound: {len(mcp_host.tool_specs)} hardware tools",
                flush=True,
            )
            return mcp_host
        except McpHostError as exc:
            print(f"[agent-spike] MCP unavailable, continuing without bench tools: {exc}", flush=True)
            return None

    harness = Harness(
        cfg=RunConfig(
            task=args.task,
            repo=args.repo,
            model=args.model,
            record_dir=args.record,
            max_turns=args.max_turns,
            max_iterations=args.max_iterations,
            run_id=run_id,
        ),
        recorder=recorder,
        provider=provider,
        workspace=workspace,
        approver=stdin_approver,
        toolhost_factory=bind_mcp,
    )
    try:
        terminal = await harness.run()
    except Exception as exc:
        # A harness/provider crash must still leave a fixture-valid, terminal
        # recording — the run failed, visibly, with the reason on the wire.
        if not recorder.sealed and recorder.seq > 0:
            recorder.emit(
                "run.failed", {"summary": f"Harness error: {type(exc).__name__}: {exc}"[:500]}
            )
        raise
    finally:
        await mcp_host.close()
    print(f"\n[agent-spike] run {run_id} ended: {terminal}")
    print(f"[agent-spike] recording: {recorder.jsonl_path} ({recorder.seq} events)")
    return 0 if terminal in ("completed", "failed", "stopped") else 1


def main() -> int:
    args = build_parser().parse_args()
    provider = LiteLLMProvider(args.model)
    print(f"[agent-spike] probing model {args.model!r} ...", flush=True)
    try:
        provider.probe()
    except ProviderStartupError as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return 2
    print("[agent-spike] probe OK", flush=True)
    return asyncio.run(_amain(args))


if __name__ == "__main__":
    sys.exit(main())
