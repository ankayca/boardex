// Deep-link routing per artifact kind (§7.4 / T3.1). resolveDeepLink is the one
// place a ?artifact=<id> param becomes a tab + highlight target; every branch is
// fail-closed and covered here.
import type { Artifact, ArtifactKind } from '@boardex/contract';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_TABS, resolveDeepLink, tabForArtifactKind } from './tabs';

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

describe('resolveDeepLink', () => {
  const artifacts = [
    artifact('art_decode', 'protocol_decode'),
    artifact('art_timing', 'timing_measurement'),
    artifact('art_serial', 'serial_log'),
  ];

  it('defaults to the Checks tab without a param', () => {
    expect(resolveDeepLink(artifacts, null)).toEqual({
      tab: 'checks',
      artifact: null,
      notice: null,
    });
  });

  it('opens the decode tab for a protocol_decode artifact', () => {
    const target = resolveDeepLink(artifacts, 'art_decode');
    expect(target.tab).toBe('decode');
    expect(target.artifact?.id).toBe('art_decode');
    expect(target.notice).toBeNull();
  });

  it('lands T3.2 kinds on Checks with the arrives-with-T3.2 notice, artifact kept for highlighting', () => {
    for (const id of ['art_timing', 'art_serial']) {
      const target = resolveDeepLink(artifacts, id);
      expect(target.tab).toBe('checks');
      expect(target.artifact?.id).toBe(id);
      expect(target.notice).toMatch(/T3\.2/);
    }
  });

  it('fails closed on an unknown artifact id', () => {
    const target = resolveDeepLink(artifacts, 'art_ghost');
    expect(target.tab).toBe('checks');
    expect(target.artifact).toBeNull();
    expect(target.notice).toMatch(/isn't part of this run's evidence/);
  });

  it('always lands on a tab that has T3.1 content', () => {
    for (const candidate of [null, 'art_decode', 'art_timing', 'art_serial', 'nope']) {
      expect(AVAILABLE_TABS.has(resolveDeepLink(artifacts, candidate).tab)).toBe(true);
    }
  });
});
