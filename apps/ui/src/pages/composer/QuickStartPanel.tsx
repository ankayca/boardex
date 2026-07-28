// Quick Start (v0) — the "+ New board" panel in the composer (BIBLE §7.2).
//
// The Board Profile Builder (§7.5) asks a firmware engineer for things they cannot
// answer at their desk: the MCU part string, the flash invocation, instrument ids.
// Those answers live in the bench scan, the repo, and the prompt. So this panel asks
// for exactly two: the repo path (here) and the task (the composer's own textarea).
// Everything else is compiled at Create-Run time by quickStartProfile.ts and stays
// editable in the full builder, which Quick Start links to as "Advanced".
//
// The path field validates on BLUR against the mock-prototyped POST /workspace/validate
// (docs/decisions.md 2026-07-28). It is feature-detected: no route, no inline states,
// and the flow still completes. Every state here is ADVISORY — the same pattern the
// bench references follow: a path we could not confirm never blocks Create Run Plan,
// the run just fails honestly if the user insists.
import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../design';
import { getRecentRepoPaths, subscribeSettings } from '../../lib/settings';
import { repoBasename } from '../../lib/repoBasename';
import { workspaceApi, type WorkspaceValidation } from '../../lib/workspaceValidate';
import { newBoardProfileId } from '../boards/profileDraft';
import { quickStartName } from './quickStartProfile';

// 'unsupported' and 'failed' both render NOTHING: the runner could not tell us, which
// says nothing about the path. Only a real answer earns an inline state.
type ProbeState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'validated'; result: WorkspaceValidation }
  | { status: 'unsupported' }
  | { status: 'failed' };

export interface QuickStart {
  repoPath: string;
  setRepoPath: (value: string) => void;
  name: string;
  setName: (value: string) => void;
  probe: ProbeState;
  validate: () => void;
  acceptSuggestion: (path: string) => void;
  /** The build command to compile into the profile; undefined → the 'make' fallback. */
  detectedBuild: string | undefined;
  /**
   * The compiled profile's id, minted ONCE per panel session: a retried Create after a
   * failure re-saves the same profile (POST /board-profiles is keyed by id) instead of
   * leaving an orphan behind on the runner.
   */
  profileId: string;
  ready: boolean;
}

/**
 * Quick Start's own state. The board name follows the repo folder until the user edits
 * it, then it is theirs — retyping the path never silently overwrites a name someone
 * chose.
 */
export function useQuickStart(initialPath = ''): QuickStart {
  const [repoPath, setRepoPathRaw] = useState(initialPath);
  const [name, setNameRaw] = useState(() => (initialPath ? quickStartName(initialPath) : ''));
  const [nameEdited, setNameEdited] = useState(false);
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });
  // One id for this panel session. A successful Create navigates away and unmounts the
  // composer, so the next board gets a fresh hook instance and a fresh id; every retry
  // in between is the SAME profile being written again, never a second one.
  const [profileId] = useState(() => newBoardProfileId());

  // Request generation. Every probe carries the generation it was issued under, and a
  // stale answer — one that resolves after the path moved on — is DISCARDED rather than
  // rendered: a verdict about a path the user has already edited is a lie about the
  // path now in the field, and its detectedBuild would otherwise ride into the
  // compiled profile's buildCommand.
  const probeGeneration = useRef(0);

  const setRepoPath = useCallback(
    (value: string) => {
      probeGeneration.current += 1; // supersede any probe still in flight
      setRepoPathRaw(value);
      setProbe({ status: 'idle' }); // a stale verdict beside a retyped path is a lie
      if (!nameEdited) setNameRaw(value.trim() ? quickStartName(value) : '');
    },
    [nameEdited],
  );

  const setName = useCallback((value: string) => {
    setNameEdited(true);
    setNameRaw(value);
  }, []);

  const probePath = useCallback((path: string) => {
    const trimmed = path.trim();
    const generation = (probeGeneration.current += 1);
    const current = () => generation === probeGeneration.current;
    if (trimmed.length === 0) {
      setProbe({ status: 'idle' });
      return;
    }
    setProbe({ status: 'checking' });
    workspaceApi
      .validate(trimmed)
      .then((answer) => {
        if (!current()) return;
        setProbe(
          answer.status === 'validated'
            ? { status: 'validated', result: answer.result }
            : { status: 'unsupported' },
        );
      })
      .catch(() => {
        if (current()) setProbe({ status: 'failed' });
      });
  }, []);

  const validate = useCallback(() => probePath(repoPath), [probePath, repoPath]);

  const acceptSuggestion = useCallback(
    (path: string) => {
      setRepoPath(path);
      probePath(path);
    },
    [probePath, setRepoPath],
  );

  const detectedBuild =
    probe.status === 'validated' && probe.result.kind === 'firmware'
      ? probe.result.detectedBuild
      : undefined;

  return {
    repoPath,
    setRepoPath,
    name,
    setName,
    probe,
    validate,
    acceptSuggestion,
    detectedBuild,
    profileId,
    ready: repoPath.trim().length > 0,
  };
}

// --- inline path states ------------------------------------------------------

// Green is a recorded pass and nothing else (D14): the runner looked and found a
// buildable firmware folder. That is a pass.
function ValidatedPath({ detectedBuild }: { detectedBuild?: string | undefined }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-meta text-pass">
      <svg viewBox="0 0 14 14" width={13} height={13} aria-hidden="true">
        <path
          d="M2.5 7.5l3 3 6-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        Firmware folder found on the runner
        {detectedBuild && (
          <>
            {' · builds with '}
            <span className="font-mono">{detectedBuild}</span>
          </>
        )}
      </span>
    </p>
  );
}

// Amber: something needs the human's decision — accept the suggestion or keep the path.
function SuggestedPath({
  suggestedPath,
  onAccept,
}: {
  suggestedPath: string;
  onAccept: () => void;
}) {
  return (
    <div role="status" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
      <p className="text-meta text-warn">
        No build file in that folder. The firmware looks like it is in{' '}
        <span className="font-mono font-medium">{repoBasename(suggestedPath)}</span>.
      </p>
      <p className="mt-0.5 font-mono text-metadata text-text-secondary">{suggestedPath}</p>
      <Button variant="secondary" className="mt-2" onClick={onAccept}>
        Use this path
      </Button>
    </div>
  );
}

function PathAdvisory({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-meta text-warn">
      {children}
    </p>
  );
}

// Red is fail/stop and nothing else (D14): the runner looked for this path and it is
// not there. Honest, and non-blocking — insisting is allowed, the run then fails for
// the same reason, out loud.
function MissingPath({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-meta text-fail">
      {children}
    </p>
  );
}

function PathState({ probe, onAccept }: { probe: ProbeState; onAccept: (path: string) => void }) {
  switch (probe.status) {
    case 'checking':
      return <p className="text-meta text-text-secondary">Checking the path on the runner…</p>;
    case 'validated': {
      const { kind, exists, suggestedPath, detectedBuild } = probe.result;
      if (kind === 'firmware') return <ValidatedPath detectedBuild={detectedBuild} />;
      if (kind === 'directory') {
        return suggestedPath ? (
          <SuggestedPath suggestedPath={suggestedPath} onAccept={() => onAccept(suggestedPath)} />
        ) : (
          <PathAdvisory>
            No build file found in that folder — the run will try <span className="font-mono">make</span>.
          </PathAdvisory>
        );
      }
      return exists ? (
        <MissingPath>That path is a file, not a folder.</MissingPath>
      ) : (
        <MissingPath>Not found on the runner.</MissingPath>
      );
    }
    // Feature-detected absent, or the probe itself failed: we know nothing about the
    // path, so we say nothing about it.
    default:
      return null;
  }
}

// --- the panel ---------------------------------------------------------------

export interface QuickStartPanelProps {
  quick: QuickStart;
  /** Rendered when profiles exist — the way back to the board selector. */
  onUseExisting?: (() => void) | undefined;
}

export function QuickStartPanel({ quick, onUseExisting }: QuickStartPanelProps) {
  const recents = useSyncExternalStore(subscribeSettings, getRecentRepoPaths, getRecentRepoPaths);

  return (
    <section
      aria-label="Quick Start"
      className="space-y-3 rounded-card border border-border bg-surface p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-body font-semibold text-text-primary">New board</h2>
          <p className="mt-0.5 text-meta text-text-secondary">
            Point Boardex at your firmware folder — the bench scan and your task fill in the
            rest; review at the plan gate.
          </p>
        </div>
        {onUseExisting && (
          <button
            type="button"
            onClick={onUseExisting}
            className="shrink-0 text-meta text-text-secondary underline underline-offset-2 hover:text-text-primary"
          >
            Use an existing board
          </button>
        )}
      </div>

      <div>
        <label
          htmlFor="quickstart-repo-path"
          className="block text-meta font-medium text-text-secondary"
        >
          Repo path
        </label>
        {/* A text input, never a file picker: the path is read on the RUNNER's
            filesystem, which is not necessarily this browser's machine. */}
        <input
          id="quickstart-repo-path"
          value={quick.repoPath}
          onChange={(event) => quick.setRepoPath(event.target.value)}
          onBlur={() => quick.validate()}
          spellCheck={false}
          autoComplete="off"
          placeholder="~/firmware/bme280-f303re"
          className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 font-mono text-body text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
        />
        <p className="mt-1 text-metadata text-text-secondary">
          The path as the runner sees it.
        </p>
      </div>

      {recents.length > 0 && (
        <div>
          <p className="text-metadata text-text-secondary">Recent</p>
          <ul aria-label="Recent repo paths" className="mt-1 flex flex-wrap gap-2">
            {recents.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  onClick={() => quick.acceptSuggestion(path)}
                  className="rounded-full border border-border bg-surface px-3 py-1 font-mono text-metadata text-text-primary transition-colors duration-fast ease-motion hover:border-border-strong"
                >
                  {repoBasename(path)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <PathState probe={quick.probe} onAccept={quick.acceptSuggestion} />

      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
        <div className="min-w-[220px] flex-1">
          <label
            htmlFor="quickstart-board-name"
            className="block text-meta font-medium text-text-secondary"
          >
            Board name
          </label>
          <input
            id="quickstart-board-name"
            value={quick.name}
            onChange={(event) => quick.setName(event.target.value)}
            placeholder="New board"
            className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-1.5 text-body text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
          />
        </div>
        <Link
          to="/boards/new"
          state={{ repoPath: quick.repoPath }}
          className="pb-1.5 text-meta text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          Advanced
        </Link>
      </div>

      {/* D12, 2026-07-28 ruling: the seeded checklist is three UNIVERSAL bench
          preconditions, never board-specific wiring — and the panel says so, so
          nobody mistakes a generic default for a checked fact about their board. */}
      <p className="text-metadata text-text-secondary">
        Bench connections start as generic defaults — refine them in Advanced. The plan gate
        still asks you to confirm each one before anything is flashed.
      </p>
    </section>
  );
}
