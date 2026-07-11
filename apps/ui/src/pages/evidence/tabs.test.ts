// Deep-link routing per artifact kind (§7.4). resolveDeepLink is the one place
// a ?artifact=<id> param becomes a tab + content target; as of T3.2 every kind
// has a live tab, so a known id routes to its viewer and only an unknown id
// fails closed (Checks + explicit notice).
import type { Artifact, ArtifactKind } from '@boardex/contract';
import { describe, expect, it } from 'vitest';
import { latestOfKind, resolveDeepLink, tabForArtifactKind } from './tabs';

const artifact = (id: string, kind: ArtifactKind): Artifact => ({
  id,
  runId: 'run_1',
  stepId: 'step_1',
  kind,
  label: `label ${id}`,
  mimeType: 'application/json',
  sizeBytes: 1,
});

describe('tabForArtifactKind', () => {
  it('maps every artifact kind to its §7.4 tab', () => {
    expect(tabForArtifactKind('protocol_decode')).toBe('decode');
    expect(tabForArtifactKind('serial_log')).toBe('logs');
    expect(tabForArtifactKind('build_log')).toBe('logs');
    expect(tabForArtifactKind('flash_log')).toBe('logs');
    expect(tabForArtifactKind('code_diff')).toBe('diff');
    expect(tabForArtifactKind('logic_capture')).toBe('raw');
    expect(tabForArtifactKind('timing_measurement')).toBe('raw');
    expect(tabForArtifactKind('report_md')).toBe('raw');
  });
});

describe('latestOfKind', () => {
  it('returns the most recently created artifact of the kind, or null', () => {
    const artifacts = [
      artifact('art_diff_1', 'code_diff'),
      artifact('art_decode', 'protocol_decode'),
      artifact('art_diff_2', 'code_diff'),
    ];
    expect(latestOfKind(artifacts, 'code_diff')?.id).toBe('art_diff_2');
    expect(latestOfKind(artifacts, 'report_md')).toBeNull();
  });
});

describe('resolveDeepLink', () => {
  const artifacts = [
    artifact('art_decode', 'protocol_decode'),
    artifact('art_timing', 'timing_measurement'),
    artifact('art_serial', 'serial_log'),
    artifact('art_build', 'build_log'),
    artifact('art_diff', 'code_diff'),
    artifact('art_report', 'report_md'),
  ];

  it('defaults to the Checks tab without a param', () => {
    expect(resolveDeepLink(artifacts, null)).toEqual({
      tab: 'checks',
      artifact: null,
      notice: null,
    });
  });

  it('routes every known artifact to its own kind tab with no notice', () => {
    const expected: [string, string][] = [
      ['art_decode', 'decode'],
      ['art_serial', 'logs'],
      ['art_build', 'logs'],
      ['art_diff', 'diff'],
      ['art_timing', 'raw'],
      ['art_report', 'raw'],
    ];
    for (const [id, tab] of expected) {
      const target = resolveDeepLink(artifacts, id);
      expect(target.tab).toBe(tab);
      expect(target.artifact?.id).toBe(id);
      expect(target.notice).toBeNull();
    }
  });

  it('fails closed on an unknown artifact id', () => {
    const target = resolveDeepLink(artifacts, 'art_ghost');
    expect(target.tab).toBe('checks');
    expect(target.artifact).toBeNull();
    expect(target.notice).toMatch(/isn't part of this run's evidence/);
  });
});
