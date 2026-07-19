// Test Connection classification (T6.6, §7.x Settings). Pure and React-free so the
// online / version-mismatch / degraded verdicts are unit-testable without a DOM — the
// unreachable ('offline') case is the component's, since it is the fetch itself
// throwing, not a payload to classify. D14 (T6.6 review F1): only `pass` is green;
// every non-pass probe verdict — mismatch, degraded, and the caller's offline — is an
// amber WARNING to resolve, never red. A failed reachability test is not a fail/stop.
import { CONTRACT_VERSION, type HealthResponse } from '@boardex/contract';

export type ConnectionResult =
  | { kind: 'online'; tone: 'pass'; runnerKind: string; contractVersion: string }
  | {
      kind: 'mismatch';
      tone: 'warn';
      runnerKind: string;
      contractVersion: string;
      expected: string;
    }
  | { kind: 'degraded'; tone: 'warn'; runnerKind: string; contractVersion: string };

/** The version this UI's contract was built against — the mismatch yardstick. */
export const EXPECTED_CONTRACT_VERSION = CONTRACT_VERSION;

/**
 * Classify a SUCCESSFUL /health payload: a runner reporting not-ready (ok:false) is a
 * degraded warning; a version other than this UI's is a mismatch warning; otherwise
 * online. Unreachable is not modeled here — a thrown fetch is 'offline' in the caller.
 */
export function classifyHealth(health: HealthResponse): ConnectionResult {
  if (!health.ok) {
    return {
      kind: 'degraded',
      tone: 'warn',
      runnerKind: health.runnerKind,
      contractVersion: health.contractVersion,
    };
  }
  if (health.contractVersion !== EXPECTED_CONTRACT_VERSION) {
    return {
      kind: 'mismatch',
      tone: 'warn',
      runnerKind: health.runnerKind,
      contractVersion: health.contractVersion,
      expected: EXPECTED_CONTRACT_VERSION,
    };
  }
  return {
    kind: 'online',
    tone: 'pass',
    runnerKind: health.runnerKind,
    contractVersion: health.contractVersion,
  };
}
