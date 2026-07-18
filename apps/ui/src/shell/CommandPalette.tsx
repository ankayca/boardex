// ⌘K / Ctrl+K command palette (BIBLE §8 T6.4): a centered overlay — overlay
// elevation (§6.1), medium motion in, instant dismiss (the ConfirmDialog precedent)
// — with a single input and a ranked result list. Sources: navigation, in-run
// context, recent runs, board profiles (see commandPalette.ts). Fuzzy match, arrow
// + Enter keyboard navigation, Esc to close.
//
// Focus discipline (§8 T6.4 item 4): the palette traps focus while open and restores
// it on close. Restoration is owned by the parent (CommandCenter) because it differs
// by exit reason — a dismiss returns focus to the opener; a navigation hands focus to
// the destination's main region — so this component reports the reason via onClose.
//
// The palette NEVER executes a state-changing command. Selecting an entry does
// exactly one thing: navigate to entry.to (see the HARD RULE in commandPalette.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMatch, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useFocusTrap } from '../design/focusTrap';
import { useRunView } from '../lib/runStore';
import { recentRuns } from './recentRuns';
import { evidenceTargets } from '../pages/workspace/evidence';
import {
  buildCommands,
  GROUP_LABELS,
  rankCommands,
  type CommandGroup,
  type RankedEntry,
  type RunContext,
} from './commandPalette';

export type CloseReason = 'dismiss' | 'navigate';

export interface CommandPaletteProps {
  onClose: (reason: CloseReason) => void;
}

// Highlight the fuzzy-matched characters of a label. Accent only — within the token
// law (§6.1), the accent is the one action color; nothing here is decorative.
function HighlightedLabel({ label, indices }: { label: string; indices: number[] }) {
  if (indices.length === 0) return <>{label}</>;
  const set = new Set(indices);
  return (
    <>
      {[...label].map((char, i) =>
        set.has(i) ? (
          <span key={i} className="font-semibold text-accent">
            {char}
          </span>
        ) : (
          <span key={i}>{char}</span>
        ),
      )}
    </>
  );
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Shared modal focus trap (§6.2 v2.3): Tab stays inside; focus restores to
  // the invoking control on close.
  useFocusTrap(dialogRef);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  // Live from the same ['runs'] query the sidebar reads (§7.1) — the sidebar keeps
  // it fresh via the global stream, so the palette's recent list stays live too.
  const runsQuery = useQuery({ queryKey: ['runs'], queryFn: () => api.listRuns() });
  const profilesQuery = useQuery({
    queryKey: ['board-profiles'],
    queryFn: () => api.listBoardProfiles(),
  });

  // In-run context: only when the palette is opened from within a run workspace.
  // /runs/new matches /runs/:id — the 'new' guard excludes the composer.
  const runExact = useMatch('/runs/:id');
  const runSub = useMatch('/runs/:id/*');
  const routeRunId = (runExact ?? runSub)?.params.id ?? '';
  const inRun = routeRunId !== '' && routeRunId !== 'new';
  const view = useRunView(inRun ? routeRunId : '');
  const runContext = useMemo<RunContext | null>(() => {
    if (!inRun || !view) return null;
    const targets = evidenceTargets(view);
    return {
      runId: routeRunId,
      hasChecks: view.checks.length > 0,
      logsArtifactId: targets.logs,
      diffArtifactId: targets.diff,
      reportArtifactId: targets.report,
    };
  }, [inRun, view, routeRunId]);

  const commands = useMemo(
    () =>
      buildCommands({
        recentRuns: recentRuns(runsQuery.data ?? []),
        boardProfiles: profilesQuery.data ?? [],
        runContext,
      }),
    [runsQuery.data, profilesQuery.data, runContext],
  );

  const ranked = useMemo(() => rankCommands(commands, query), [commands, query]);

  // Keep the active row valid as the filtered list shrinks/grows.
  useEffect(() => {
    setActiveIndex((current) => (ranked.length === 0 ? 0 : Math.min(current, ranked.length - 1)));
  }, [ranked.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const select = (item: RankedEntry | undefined) => {
    if (!item) return;
    // The one and only effect of selecting an entry: navigate to its surface.
    navigate(item.entry.to);
    onClose('navigate');
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => (ranked.length === 0 ? 0 : (i + 1) % ranked.length));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => (ranked.length === 0 ? 0 : (i - 1 + ranked.length) % ranked.length));
        break;
      case 'Enter':
        event.preventDefault();
        select(ranked[activeIndex]);
        break;
      case 'Escape':
        // Esc convention (§6.2 v2.3): consume with stopPropagation — only the
        // topmost surface closes, never one beneath it.
        event.preventDefault();
        event.stopPropagation();
        onClose('dismiss');
        break;
      // Tab is owned by the shared focus trap (design/focusTrap): the input is
      // the palette's only tabbable, so the cycle keeps focus there.
      default:
        break;
    }
  };

  const activeId = ranked[activeIndex] ? `cmd-opt-${ranked[activeIndex]!.entry.id}` : undefined;

  // Walk the (group-contiguous) ranked list, emitting a header when the group changes.
  let lastGroup: CommandGroup | null = null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      {/* Scrim: medium fade in, instant out (ConfirmDialog precedent). */}
      <div
        className="absolute inset-0 animate-overlay-in bg-scrim"
        onClick={() => onClose('dismiss')}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative flex max-h-[70vh] w-full max-w-xl animate-palette-in flex-col overflow-hidden rounded-card border border-border bg-surface shadow-overlay outline-none"
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={activeId}
          aria-label="Search commands, runs, and boards"
          placeholder="Search runs, boards, and pages…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          className="w-full shrink-0 border-b border-border bg-transparent px-4 py-3 text-section text-text-primary outline-none placeholder:text-text-secondary"
        />

        <ul
          id="command-palette-list"
          role="listbox"
          aria-label="Results"
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {ranked.length === 0 ? (
            <li className="px-4 py-6 text-center text-meta text-text-secondary">No matches.</li>
          ) : (
            ranked.map((item, index) => {
              const showHeader = item.entry.group !== lastGroup;
              lastGroup = item.entry.group;
              const active = index === activeIndex;
              return (
                <li key={item.entry.id}>
                  {showHeader && (
                    <p className="px-4 pb-1 pt-3 text-metadata font-medium uppercase tracking-wide text-text-secondary">
                      {GROUP_LABELS[item.entry.group]}
                    </p>
                  )}
                  <div
                    id={`cmd-opt-${item.entry.id}`}
                    role="option"
                    aria-selected={active}
                    onClick={() => select(item)}
                    onMouseMove={() => setActiveIndex(index)}
                    className={`mx-1 flex cursor-pointer items-center justify-between gap-3 rounded-control px-3 py-2 text-body ${
                      active ? 'bg-neutral-badge-bg text-text-primary' : 'text-text-primary'
                    }`}
                  >
                    <span className="min-w-0 truncate">
                      <HighlightedLabel label={item.entry.label} indices={item.indices} />
                    </span>
                    {item.entry.hint && (
                      <span className="shrink-0 truncate text-meta text-text-secondary">
                        {item.entry.hint}
                      </span>
                    )}
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
