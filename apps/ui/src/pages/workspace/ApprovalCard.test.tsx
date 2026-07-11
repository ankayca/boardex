// Approval Card (BIBLE §7.3): full proposal render, expandable files-changed list,
// approve/reject wiring, Review Diff as a deep link into the Evidence Detail Code
// Diff tab (fail-closed and inert when the run has no diff artifact yet), and the
// fail-closed blocked card with no Approve control anywhere in the DOM.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApprovalCard, type ApprovalCardProps } from './ApprovalCard';
import { approval, RUN_ID } from './test-events';

const DIFF_HREF = `/runs/${RUN_ID}/evidence?artifact=art_diff_iter1`;

function renderCard(overrides: Partial<ApprovalCardProps> = {}) {
  const onResolve = vi.fn();
  render(
    <MemoryRouter>
      <ApprovalCard
        gate={{ kind: 'ready', approval: approval('apr_flash') }}
        diffHref={DIFF_HREF}
        resolving={false}
        resolveError={null}
        onResolve={onResolve}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onResolve };
}

describe('ApprovalCard', () => {
  it('renders the proposal: title, reason, risk badge, files count, hardware actions', () => {
    renderCard();
    expect(screen.getByText('Flash firmware to the Nucleo-F303RE')).toBeInTheDocument();
    expect(
      screen.getByText('The build must be programmed to the target before I2C capture.'),
    ).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Approval required' });
    expect(card.querySelector('[data-kind="risk"][data-value="medium"]')).not.toBeNull();
    const actions = within(screen.getByRole('list', { name: 'Hardware actions' }));
    expect(actions.getByText('Flash bme280-f303re.elf via pyOCD')).toBeInTheDocument();
    expect(actions.getByText('Reset target after programming')).toBeInTheDocument();
  });

  it('expands the files-changed list on demand', async () => {
    const user = userEvent.setup();
    renderCard();
    const toggle = screen.getByRole('button', { name: '1 file changed' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Files changed' })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByRole('list', { name: 'Files changed' })).getByText('main.c')).toBeInTheDocument();
  });

  it('resolves approved / rejected through the buttons', async () => {
    const user = userEvent.setup();
    const { onResolve } = renderCard();

    await user.click(screen.getByRole('button', { name: 'Approve & Continue' }));
    expect(onResolve).toHaveBeenCalledWith(approval('apr_flash'), 'approved');

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onResolve).toHaveBeenCalledWith(approval('apr_flash'), 'rejected');
  });

  it('disables Approve and Reject while a resolution is pending (idempotent-safe)', () => {
    renderCard({ resolving: true });
    expect(screen.getByRole('button', { name: 'Resolving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });

  it('Review Diff deep-links the evidence drawer’s Code Diff tab at the latest diff artifact', () => {
    renderCard();
    const link = screen.getByRole('link', { name: 'Review Diff' });
    expect(link).toHaveAttribute('href', DIFF_HREF);
  });

  it('fail-closed: with no diff artifact yet, Review Diff is inert and says why', () => {
    renderCard({ diffHref: null });
    expect(screen.queryByRole('link', { name: 'Review Diff' })).not.toBeInTheDocument();
    const inert = screen.getByText('Review Diff');
    expect(inert).toHaveAttribute('aria-disabled', 'true');
    expect(inert).toHaveAttribute('title', 'No code diff has been produced for this run yet.');
  });

  it('surfaces a non-conflict resolve error as an alert', () => {
    renderCard({ resolveError: 'Could not resolve the approval.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not resolve the approval.');
  });

  it('fail-closed: a blocked gate renders the blocked card with no Approve control in the DOM', () => {
    render(
      <MemoryRouter>
        <ApprovalCard
          gate={{ kind: 'blocked', reason: 'No pending approval has arrived in view.' }}
          diffHref={DIFF_HREF}
          resolving={false}
          resolveError={null}
          onResolve={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Approval blocked');
    expect(screen.getByText('No pending approval has arrived in view.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review Diff' })).not.toBeInTheDocument();
  });
});
