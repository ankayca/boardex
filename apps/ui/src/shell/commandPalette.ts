// Command palette entry model + ranking (BIBLE §8 T6.4). Pure and React-free so the
// ranking and — critically — the "never executes" law are testable without a DOM.
//
// ┌──────────────────────────────────────────────────────────────────────────────┐
// │ HARD RULE (T6.4): a palette entry is a DESTINATION, never a command. Every     │
// │ CommandEntry carries a `to` route and nothing else — there is no onSelect, no  │
// │ handler, no api reference anywhere in this model. Selecting an entry navigates; │
// │ it can NEVER approve, reject, stop, or otherwise change run state. "Approve"    │
// │ is not an entry — "Go to run" is, and the run's own approval card does the      │
// │ approving. This is enforced structurally by the type: to add a state-changing   │
// │ action you would have to add a field that does not exist here.                  │
// └──────────────────────────────────────────────────────────────────────────────┘
import type { BoardProfile, RunStatus, RunSummary } from '@boardex/contract';
import { evidenceHref } from '../pages/workspace/evidence';
import { fuzzyMatch } from './fuzzy';

export type CommandGroup = 'navigation' | 'run' | 'recent' | 'boards';

export interface CommandEntry {
  /** Stable, unique key for React and for keyboard-navigation addressing. */
  id: string;
  label: string;
  /** Muted secondary text (status, MCU) — shown, but not part of the match text. */
  hint?: string;
  group: CommandGroup;
  /** The route this entry navigates to. The ONLY effect of selecting an entry. */
  to: string;
}

// Contextual "inside a run" targets, gated exactly like the evidence-band buttons
// (§7.3): a target is a real artifact id (or null when that artifact does not exist
// yet). Inert entries are omitted from the palette, never rendered disabled.
export interface RunContext {
  runId: string;
  /** The run has at least one evaluated check → the evidence overview is non-empty. */
  hasChecks: boolean;
  logsArtifactId: string | null;
  diffArtifactId: string | null;
  reportArtifactId: string | null;
}

export interface CommandSources {
  /** Recent runs, most-recent first — the same list the sidebar shows (§7.1). */
  recentRuns: readonly RunSummary[];
  boardProfiles: readonly BoardProfile[];
  /** Present only while the palette is opened from within a run workspace. */
  runContext: RunContext | null;
}

// Group render order — also the empty-query listing order (§8 T6.4 "Sources,
// ranked": navigation, then in-run context, then recent runs, then boards).
const GROUP_ORDER: readonly CommandGroup[] = ['navigation', 'run', 'recent', 'boards'];

export const GROUP_LABELS: Record<CommandGroup, string> = {
  navigation: 'Navigation',
  run: 'This run',
  recent: 'Recent runs',
  boards: 'Boards',
};

function statusHint(status: RunStatus): string {
  return status.replace(/_/g, ' ');
}

/**
 * Build the full, unfiltered entry list in default (group) order. Every entry is a
 * navigation target — see the HARD RULE above.
 */
export function buildCommands(sources: CommandSources): CommandEntry[] {
  const entries: CommandEntry[] = [];

  // 1. Navigation — the app-wide surfaces we have (Settings added T6.6). The dev-only
  //    /design gallery is not a product surface and is deliberately absent.
  entries.push(
    { id: 'nav:runs', label: 'Runs', hint: 'Go to run list', group: 'navigation', to: '/' },
    { id: 'nav:new-run', label: 'New Run', hint: 'Start a run', group: 'navigation', to: '/runs/new' },
    { id: 'nav:boards', label: 'Boards', hint: 'Board profiles', group: 'navigation', to: '/boards' },
    { id: 'nav:settings', label: 'Settings', hint: 'Runner & preferences', group: 'navigation', to: '/settings' },
  );

  // 2. In-run context — actions navigate to their surface (the approval card etc.
  //    lives on the run page; the palette only takes you there). Each entry appears
  //    only when its artifact exists, mirroring the band buttons exactly.
  const ctx = sources.runContext;
  if (ctx) {
    if (ctx.hasChecks) {
      entries.push({
        id: 'run:evidence',
        label: 'Open Evidence',
        group: 'run',
        to: `/runs/${ctx.runId}/evidence`,
      });
    }
    if (ctx.reportArtifactId) {
      entries.push({
        id: 'run:report',
        label: 'Open Report',
        group: 'run',
        to: `/runs/${ctx.runId}/report`,
      });
    }
    if (ctx.logsArtifactId) {
      entries.push({
        id: 'run:logs',
        label: 'Open Logs',
        group: 'run',
        to: evidenceHref(ctx.runId, ctx.logsArtifactId),
      });
    }
    if (ctx.diffArtifactId) {
      entries.push({
        id: 'run:diff',
        label: 'Open Diff',
        group: 'run',
        to: evidenceHref(ctx.runId, ctx.diffArtifactId),
      });
    }
  }

  // 3. Recent runs by title.
  for (const run of sources.recentRuns) {
    entries.push({
      id: `recent:${run.id}`,
      label: run.title,
      hint: statusHint(run.status),
      group: 'recent',
      to: `/runs/${run.id}`,
    });
  }

  // 4. Board profiles by name.
  for (const profile of sources.boardProfiles) {
    entries.push({
      id: `board:${profile.id}`,
      label: profile.name,
      hint: profile.mcu,
      group: 'boards',
      to: `/boards/${profile.id}`,
    });
  }

  return entries;
}

export interface RankedEntry {
  entry: CommandEntry;
  /** Matched indices into the label, for highlight rendering (empty when no query). */
  indices: number[];
}

function groupRank(group: CommandGroup): number {
  const i = GROUP_ORDER.indexOf(group);
  return i === -1 ? GROUP_ORDER.length : i;
}

/**
 * Filter + rank entries for a query. Groups stay contiguous (sorted by GROUP_ORDER),
 * so the list renders under stable section headers; within a group, entries are
 * ordered by fuzzy score. An empty query keeps every entry in default order.
 */
export function rankCommands(commands: readonly CommandEntry[], query: string): RankedEntry[] {
  const q = query.trim();

  const scored = commands
    .map((entry, index) => {
      const match = fuzzyMatch(q, entry.label);
      return match ? { entry, index, score: match.score, indices: match.indices } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  scored.sort((a, b) => {
    const byGroup = groupRank(a.entry.group) - groupRank(b.entry.group);
    if (byGroup !== 0) return byGroup;
    // Within a group: best score first when querying; original order when not.
    if (q !== '' && b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.map(({ entry, indices }) => ({ entry, indices }));
}
