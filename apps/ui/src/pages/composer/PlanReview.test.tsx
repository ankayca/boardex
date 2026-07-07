// The D12 checklist gate (BIBLE §7.2): every connectionChecklist line must be
// confirmed before Approve Plan enables — and unchecking any line re-arms the gate.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlanStep } from '@boardex/contract';
import { PlanReview, type PlanReviewProps } from './PlanReview';

const PLAN: PlanStep[] = [
  {
    index: 0,
    title: 'Understand the task and board context',
    detail: 'Read the datasheet.',
    riskLevel: 'low',
    hardwareAction: false,
  },
  {
    index: 1,
    title: 'Build and flash the firmware',
    detail: 'Flashing needs approval.',
    riskLevel: 'medium',
    hardwareAction: true,
  },
];

const CHECKLIST = [
  { label: 'SCL — PB8', detail: 'Nucleo PB8 to BME280 SCL' },
  { label: 'SDA — PB9', detail: 'Nucleo PB9 to BME280 SDA' },
  { label: 'GND', detail: 'Common ground' },
];

function renderReview(over: Partial<PlanReviewProps> = {}) {
  const onApprove = vi.fn();
  const onEditTask = vi.fn();
  render(
    <PlanReview
      plan={PLAN}
      riskSummary="One medium-risk hardware action."
      checklist={CHECKLIST}
      profileResolved
      degradedDevices={[]}
      approving={false}
      onApprove={onApprove}
      onEditTask={onEditTask}
      {...over}
    />,
  );
  return { onApprove, onEditTask };
}

describe('PlanReview checklist gate (D12)', () => {
  it('renders every checklist line and keeps Approve disabled until each is confirmed', async () => {
    const user = userEvent.setup();
    const { onApprove } = renderReview();

    const approve = screen.getByRole('button', { name: 'Approve Plan' });
    expect(approve).toBeDisabled();

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(CHECKLIST.length);
    for (const item of CHECKLIST) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }

    // Confirm all but one: still gated.
    await user.click(boxes[0] as HTMLElement);
    await user.click(boxes[1] as HTMLElement);
    expect(approve).toBeDisabled();

    // The last line confirms via keyboard (space), proving the gate is operable
    // without a pointer.
    (boxes[2] as HTMLElement).focus();
    await user.keyboard(' ');
    expect(approve).toBeEnabled();

    await user.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('re-arms the gate when a confirmed line is unchecked', async () => {
    const user = userEvent.setup();
    renderReview();

    const approve = screen.getByRole('button', { name: 'Approve Plan' });
    const boxes = screen.getAllByRole('checkbox');
    for (const box of boxes) await user.click(box);
    expect(approve).toBeEnabled();

    await user.click(boxes[1] as HTMLElement);
    expect(approve).toBeDisabled();
  });

  it('leaves Approve ungated when a RESOLVED profile genuinely has no checklist (§7.2)', () => {
    renderReview({ checklist: [] });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve Plan' })).toBeEnabled();
  });

  it('fail-closed: an empty checklist never enables Approve while the profile is unresolved', () => {
    renderReview({ checklist: [], profileResolved: false });
    expect(screen.getByRole('button', { name: 'Approve Plan' })).toBeDisabled();
  });

  it('fail-closed: unresolved profile keeps Approve disabled even with every line confirmed', async () => {
    const user = userEvent.setup();
    renderReview({ profileResolved: false });
    for (const box of screen.getAllByRole('checkbox')) {
      await user.click(box);
    }
    expect(screen.getByRole('button', { name: 'Approve Plan' })).toBeDisabled();
  });

  it('renders the plan with risk badges, hardware markers and the risk summary', () => {
    renderReview();

    const steps = within(screen.getByRole('list', { name: 'Plan steps' })).getAllByRole(
      'listitem',
    );
    expect(steps).toHaveLength(2);
    expect(screen.getByText('Build and flash the firmware')).toBeInTheDocument();
    expect(screen.getByText('Hardware action')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('One medium-risk hardware action.')).toBeInTheDocument();
  });

  it('repeats the degraded-bench warning at approval time', () => {
    renderReview({
      degradedDevices: [
        { id: 'sigrok:kingst-la2016:conn=3.12', name: 'Kingst LA2016', state: 'offline' },
      ],
    });
    expect(screen.getByText('Bench degraded')).toBeInTheDocument();
    expect(screen.getByText(/Kingst LA2016 — offline/)).toBeInTheDocument();
  });

  it('returns to the composer via Edit task', async () => {
    const user = userEvent.setup();
    const { onEditTask } = renderReview();
    await user.click(screen.getByRole('button', { name: 'Edit task' }));
    expect(onEditTask).toHaveBeenCalledTimes(1);
  });
});
