// Test Connection verdict classification (T6.6). Online / version-mismatch / degraded
// are payload-derived and pure; the unreachable 'offline' case is the fetch throwing,
// covered at the component level in SettingsPage.test.tsx.
import { describe, expect, it } from 'vitest';
import type { HealthResponse } from '@boardex/contract';
import { EXPECTED_CONTRACT_VERSION, classifyHealth } from './testConnection';

const base: HealthResponse = {
  ok: true,
  contractVersion: EXPECTED_CONTRACT_VERSION,
  runnerKind: 'mock',
};

describe('classifyHealth', () => {
  it('online: ok + matching contract version → pass tone', () => {
    expect(classifyHealth(base)).toEqual({
      kind: 'online',
      tone: 'pass',
      runnerKind: 'mock',
      contractVersion: EXPECTED_CONTRACT_VERSION,
    });
  });

  it('mismatch: reachable but a different contract version → warn tone', () => {
    const result = classifyHealth({ ...base, contractVersion: 'boardex-contract/0.2' });
    expect(result).toEqual({
      kind: 'mismatch',
      tone: 'warn',
      runnerKind: 'mock',
      contractVersion: 'boardex-contract/0.2',
      expected: EXPECTED_CONTRACT_VERSION,
    });
  });

  it('degraded: reachable but the runner reports not ready (ok:false) → warn tone', () => {
    const result = classifyHealth({ ...base, ok: false });
    expect(result).toMatchObject({ kind: 'degraded', tone: 'warn', runnerKind: 'mock' });
  });
});
