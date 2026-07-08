// Fail-closed approval gate (decisions.md 2026-07-07): only a single, well-formed
// pending approval yields a ready gate; missing, ambiguous, malformed, or blank
// proposal context blocks. Views come from the real reduceRun (D5).
import { describe, expect, it } from 'vitest';
import type { Event } from '@boardex/contract';
import { deriveApprovalGate } from './approvalGate';
import { approval, envelope, run, viewFrom } from './test-events';

const awaiting = (...rest: Event[]): Event[] => [
  envelope(1, 'run.created', { run }),
  envelope(2, 'run.status_changed', { status: 'awaiting_approval' }),
  ...rest,
];

describe('deriveApprovalGate', () => {
  it('is ready on exactly one well-formed pending approval', () => {
    const view = viewFrom(awaiting(envelope(3, 'approval.requested', { approval: approval('apr_1') })));
    const gate = deriveApprovalGate(view);
    expect(gate).toEqual({ kind: 'ready', approval: approval('apr_1') });
  });

  it('blocks when the run awaits approval but no pending approval is in view', () => {
    const gate = deriveApprovalGate(viewFrom(awaiting()));
    expect(gate.kind).toBe('blocked');
  });

  it('blocks when the only approval in view is already resolved', () => {
    const view = viewFrom(
      awaiting(
        envelope(3, 'approval.requested', { approval: approval('apr_1') }),
        envelope(4, 'approval.resolved', {
          approvalId: 'apr_1',
          status: 'approved',
          resolvedAt: '2026-07-08T12:01:00.000Z',
        }),
      ),
    );
    expect(deriveApprovalGate(view).kind).toBe('blocked');
  });

  it('blocks on more than one pending approval (ambiguous context)', () => {
    const view = viewFrom(
      awaiting(
        envelope(3, 'approval.requested', { approval: approval('apr_1') }),
        envelope(4, 'approval.requested', { approval: approval('apr_2') }),
      ),
    );
    expect(deriveApprovalGate(view).kind).toBe('blocked');
  });

  it('blocks on a blank proposal title or reason', () => {
    for (const proposal of [{ title: '  ' }, { reason: '' }]) {
      const view = viewFrom(
        awaiting(envelope(3, 'approval.requested', { approval: approval('apr_1', proposal) })),
      );
      expect(deriveApprovalGate(view).kind).toBe('blocked');
    }
  });

  it('blocks on structurally malformed proposal data (untyped source)', () => {
    const broken = approval('apr_1') as unknown as { proposal: Record<string, unknown> };
    delete broken.proposal['riskLevel'];
    const view = viewFrom(
      awaiting({
        seq: 3,
        runId: run.id,
        ts: '2026-07-08T12:00:00.000Z',
        type: 'approval.requested',
        payload: { approval: broken },
      } as unknown as Event),
    );
    expect(deriveApprovalGate(view).kind).toBe('blocked');
  });
});
