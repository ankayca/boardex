// Approval Card (BIBLE §7.3): full proposal render, expandable files-changed list,
// approve/reject wiring, the T3.2 diff-drawer placeholder, and the fail-closed
// blocked card with no Approve control anywhere in the DOM.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalCard, type ApprovalCardProps } from './ApprovalCard';
import { approval } from './test-events';

function renderCard(overrides: Partial<ApprovalCardProps> = {}) {
  const onResolve = vi.fn();
  render(
    <ApprovalCard
      gate={{ kind: 'ready', approval: approval('apr_flash') }}
      resolving={false}
      resolveError={null}
      onResolve={onResolve}
      {...overrides}
    />,
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

  it('opens the diff drawer as a T3.2 placeholder — no diff rendering', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Review Diff' }));
    const drawer = within(screen.getByRole('dialog', { name: 'Proposed changes' }));
    expect(drawer.getByText(/Diff rendering arrives with T3\.2/)).toBeInTheDocument();
    expect(drawer.getByText('main.c')).toBeInTheDocument();
  });

  it('surfaces a non-conflict resolve error as an alert', () => {
    renderCard({ resolveError: 'Could not resolve the approval.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not resolve the approval.');
  });

  it('fail-closed: a blocked gate renders the blocked card with no Approve control in the DOM', () => {
    render(
      <ApprovalCard
        gate={{ kind: 'blocked', reason: 'No pending approval has arrived in view.' }}
        resolving={false}
        resolveError={null}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Approval blocked');
    expect(screen.getByText('No pending approval has arrived in view.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });
});
