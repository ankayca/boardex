// Diagnosis Card (BIBLE §7.3): failed checks summarized with Sprint-3 evidence stub
// links, hypotheses ranked by confidence with labels, proposed fix + risk, and the
// fail-closed Approve Fix Plan — present only once the fix approval is pending.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Diagnosis } from '@boardex/contract';
import { DiagnosisCard, type DiagnosisCardProps } from './DiagnosisCard';
import { rankHypotheses } from './hypotheses';
import { approval, diagnosis, failedCheck, RUN_ID } from './test-events';

// Deliberately shuffled: ranked render order must be high, moderate, low.
const HYPOTHESES: Diagnosis['hypotheses'] = [
  { cause: 'Pull-up issue', evidence: 'Unlikely: framing is clean.', confidence: 'low' },
  { cause: 'Address shift missing', evidence: 'Decode shows NACK at 0x3B.', confidence: 'high' },
  { cause: 'Init order', evidence: 'Possible: first transfer garbled.', confidence: 'moderate' },
];

const CHECKS = [
  failedCheck('chk_device_ack', 'art_decode', 'BME280 must ACK at address 0x76'),
  failedCheck('chk_serial_output', 'art_serial', 'Serial must show TEMP/HUM readings'),
];

function renderCard(overrides: Partial<DiagnosisCardProps> = {}) {
  const onApproveFix = vi.fn();
  render(
    <MemoryRouter>
      <DiagnosisCard
        diagnosis={diagnosis(HYPOTHESES, ['chk_device_ack', 'chk_serial_output'])}
        checks={CHECKS}
        runId={RUN_ID}
        fixApproval={null}
        resolving={false}
        onApproveFix={onApproveFix}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onApproveFix };
}

describe('rankHypotheses', () => {
  it('orders high before moderate before low, stably, without mutating the input', () => {
    const ranked = rankHypotheses(HYPOTHESES);
    expect(ranked.map((h) => h.confidence)).toEqual(['high', 'moderate', 'low']);
    expect(HYPOTHESES.map((h) => h.confidence)).toEqual(['low', 'high', 'moderate']);
    const twoHigh = rankHypotheses([
      { cause: 'A', evidence: '', confidence: 'high' },
      { cause: 'B', evidence: '', confidence: 'high' },
    ]);
    expect(twoHigh.map((h) => h.cause)).toEqual(['A', 'B']);
  });
});

describe('DiagnosisCard', () => {
  it('renders hypotheses ranked by confidence, with confidence labels and evidence text', () => {
    renderCard();
    const items = within(screen.getByRole('list', { name: 'Hypotheses' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Address shift missing'),
      expect.stringContaining('Init order'),
      expect.stringContaining('Pull-up issue'),
    ]);
    expect(items[0]).toHaveTextContent('High confidence');
    expect(items[1]).toHaveTextContent('Moderate confidence');
    expect(items[2]).toHaveTextContent('Low confidence');
    expect(items[0]).toHaveTextContent('Decode shows NACK at 0x3B.');
  });

  it('summarizes failed checks with FAIL badges and evidence stub links', () => {
    renderCard();
    const failed = within(screen.getByRole('list', { name: 'Failed checks' }));
    expect(failed.getByText('BME280 must ACK at address 0x76')).toBeInTheDocument();
    expect(failed.getByText('Serial must show TEMP/HUM readings')).toBeInTheDocument();
    expect(failed.getAllByText('FAIL')).toHaveLength(2);
    const links = failed.getAllByRole('link', { name: 'View evidence' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/runs/${RUN_ID}/evidence?artifact=art_decode`,
      `/runs/${RUN_ID}/evidence?artifact=art_serial`,
    ]);
  });

  it('renders the proposed fix summary, risk badge, and files', () => {
    renderCard();
    expect(
      screen.getByText('Compose CR2 SADD from the shifted address and re-flash.'),
    ).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Diagnosis' });
    expect(card.querySelector('[data-kind="risk"][data-value="medium"]')).not.toBeNull();
    expect(within(screen.getByRole('list', { name: 'Fix files changed' })).getByText('main.c')).toBeInTheDocument();
  });

  it('fail-closed: no Approve Fix Plan in the DOM until the fix approval is pending', () => {
    renderCard();
    expect(screen.queryByRole('button', { name: /approve fix plan/i })).not.toBeInTheDocument();
    expect(screen.getByText(/waiting for the runner to request approval/i)).toBeInTheDocument();
  });

  it('approves the pending fix approval via Approve Fix Plan', async () => {
    const user = userEvent.setup();
    const fix = approval('apr_fix');
    const { onApproveFix } = renderCard({ fixApproval: fix });
    await user.click(screen.getByRole('button', { name: 'Approve Fix Plan' }));
    expect(onApproveFix).toHaveBeenCalledWith(fix);
  });

  it('disables Approve Fix Plan while a resolution is pending', () => {
    renderCard({ fixApproval: approval('apr_fix'), resolving: true });
    expect(screen.getByRole('button', { name: 'Resolving…' })).toBeDisabled();
  });
});
