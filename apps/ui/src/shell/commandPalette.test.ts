import { describe, expect, it } from 'vitest';
import type { BoardProfile, RunSummary } from '@boardex/contract';
import {
  buildCommands,
  rankCommands,
  type CommandSources,
  type RunContext,
} from './commandPalette';

function run(id: string, title: string): RunSummary {
  return { id, title, status: 'running', boardProfileId: 'bp', updatedAt: '2026-07-12T10:00:00Z' };
}

function profile(id: string, name: string, mcu: string): BoardProfile {
  return { id, name, mcu } as BoardProfile;
}

const EMPTY: CommandSources = { recentRuns: [], boardProfiles: [], runContext: null };

describe('buildCommands', () => {
  it('always includes the three navigation destinations', () => {
    const entries = buildCommands(EMPTY);
    expect(entries.map((e) => e.to)).toEqual(['/', '/runs/new', '/boards']);
    expect(entries.every((e) => e.group === 'navigation')).toBe(true);
  });

  it('maps recent runs and board profiles to their routes', () => {
    const entries = buildCommands({
      ...EMPTY,
      recentRuns: [run('r1', 'BME280 bring-up')],
      boardProfiles: [profile('bp1', 'Nucleo-F303RE', 'STM32F303RE')],
    });
    const recent = entries.find((e) => e.group === 'recent');
    const board = entries.find((e) => e.group === 'boards');
    expect(recent).toMatchObject({ label: 'BME280 bring-up', to: '/runs/r1' });
    expect(board).toMatchObject({ label: 'Nucleo-F303RE', hint: 'STM32F303RE', to: '/boards/bp1' });
  });

  describe('in-run contextual entries gate on artifact existence', () => {
    const full: RunContext = {
      runId: 'r1',
      hasChecks: true,
      logsArtifactId: 'a-log',
      diffArtifactId: 'a-diff',
      reportArtifactId: 'a-report',
    };

    it('offers all four surfaces when checks and every artifact exist', () => {
      const runEntries = buildCommands({ ...EMPTY, runContext: full }).filter(
        (e) => e.group === 'run',
      );
      expect(runEntries.map((e) => e.label)).toEqual([
        'Open Evidence',
        'Open Report',
        'Open Logs',
        'Open Diff',
      ]);
      expect(runEntries.find((e) => e.label === 'Open Logs')!.to).toBe(
        '/runs/r1/evidence?artifact=a-log',
      );
      expect(runEntries.find((e) => e.label === 'Open Report')!.to).toBe('/runs/r1/report');
    });

    it('OMITS inert entries (no artifact / no checks) rather than showing them disabled', () => {
      const runEntries = buildCommands({
        ...EMPTY,
        runContext: {
          runId: 'r1',
          hasChecks: false,
          logsArtifactId: 'a-log',
          diffArtifactId: null,
          reportArtifactId: null,
        },
      }).filter((e) => e.group === 'run');
      // Only Logs survives — Evidence (no checks), Report and Diff (no artifact) vanish.
      expect(runEntries.map((e) => e.label)).toEqual(['Open Logs']);
    });

    it('adds no run entries when the palette is not opened inside a run', () => {
      expect(buildCommands(EMPTY).some((e) => e.group === 'run')).toBe(false);
    });
  });

  it('HARD RULE: every entry is a pure navigation destination — a route, no executable action', () => {
    const entries = buildCommands({
      recentRuns: [run('r1', 'BME280 bring-up')],
      boardProfiles: [profile('bp1', 'Nucleo', 'STM32')],
      runContext: {
        runId: 'r1',
        hasChecks: true,
        logsArtifactId: 'a-log',
        diffArtifactId: 'a-diff',
        reportArtifactId: 'a-report',
      },
    });
    for (const entry of entries) {
      // A destination, not a command: `to` is a real route…
      expect(typeof entry.to).toBe('string');
      expect(entry.to.startsWith('/')).toBe(true);
      // …and no field on the entry is a function (nothing to execute, ever).
      for (const value of Object.values(entry)) {
        expect(typeof value).not.toBe('function');
      }
    }
  });
});

describe('rankCommands', () => {
  const sources: CommandSources = {
    recentRuns: [run('r1', 'BME280 bring-up'), run('r2', 'Blink smoke test')],
    boardProfiles: [profile('bp1', 'Nucleo-F303RE', 'STM32F303RE')],
    runContext: null,
  };
  const commands = buildCommands(sources);

  it('keeps every entry in default group order for an empty query', () => {
    const groups = rankCommands(commands, '').map((r) => r.entry.group);
    // navigation block, then recent block, then boards block — contiguous.
    expect(groups).toEqual(['navigation', 'navigation', 'navigation', 'recent', 'recent', 'boards']);
  });

  it('filters to fuzzy matches and ranks within a group by score', () => {
    // "bme2" is a subsequence of "BME280 bring-up" only ("Blink smoke test" has no 2).
    const ranked = rankCommands(commands, 'bme2');
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.entry.label).toBe('BME280 bring-up');
    expect(ranked[0]!.indices.length).toBeGreaterThan(0);
  });

  it('keeps groups contiguous even when matches span several groups', () => {
    // "b" hits Boards (nav), Blink (recent), BME280 (recent), Nucleo? no — and the
    // board profile. Whatever matches, groups never interleave.
    const groups = rankCommands(commands, 'b').map((r) => r.entry.group);
    const firstBoards = groups.indexOf('boards');
    const lastRecent = groups.lastIndexOf('recent');
    if (firstBoards !== -1 && lastRecent !== -1) {
      expect(lastRecent).toBeLessThan(firstBoards);
    }
    // Contiguity: each group appears as one unbroken run.
    const seen = new Set<string>();
    let prev = '';
    for (const g of groups) {
      if (g !== prev) {
        expect(seen.has(g)).toBe(false);
        seen.add(g);
        prev = g;
      }
    }
  });
});
