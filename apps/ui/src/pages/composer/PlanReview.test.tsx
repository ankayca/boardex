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
      issues={[]}
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

    const approve = screen.getByRole('button', { name: /approve plan/i });
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

    const approve = screen.getByRole('button', { name: /approve plan/i });
    const boxes = screen.getAllByRole('checkbox');
    for (const box of boxes) await user.click(box);
    expect(approve).toBeEnabled();

    await user.click(boxes[1] as HTMLElement);
    expect(approve).toBeDisabled();
  });

  it('leaves Approve ungated when a RESOLVED profile genuinely has no checklist (§7.2)', () => {
    renderReview({ checklist: [] });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve plan/i })).toBeEnabled();
  });

  it('fail-closed: an empty checklist never enables Approve while the profile is unresolved', () => {
    renderReview({ checklist: [], profileResolved: false });
    expect(screen.getByRole('button', { name: /approve plan/i })).toBeDisabled();
  });

  it('fail-closed: unresolved profile keeps Approve disabled even with every line confirmed', async () => {
    const user = userEvent.setup();
    renderReview({ profileResolved: false });
    for (const box of screen.getAllByRole('checkbox')) {
      await user.click(box);
    }
    expect(screen.getByRole('button', { name: /approve plan/i })).toBeDisabled();
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

  // §7.2/D12: the operator confirms wiring with the bench state in view, so the
  // repeated warning must sit next to the gate — not scrolled away above the plan.
  it('repeats the bench warning at approval time, adjacent to and above the gate', () => {
    renderReview({
      issues: [
        {
          key: 'sigrok:kingst-la2016:conn=3.12',
          status: 'degraded',
          message: 'Kingst LA2016 is on the bench but offline (Not detected by sigrok)',
          deviceState: 'offline',
        },
      ],
    });
    const warning = screen.getByText('Bench degraded');
    expect(warning).toBeInTheDocument();
    expect(
      screen.getByText('Kingst LA2016 is on the bench but offline (Not detected by sigrok)'),
    ).toBeInTheDocument();

    const gate = screen.getByText('Confirm bench connections');
    expect(warning.compareDocumentPosition(gate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names an unmatched profile reference distinctly at the gate', () => {
    renderReview({
      issues: [
        {
          key: 'missing:logic_analyzer',
          status: 'missing',
          message: 'Saleae Logic 8 was not found on the bench',
        },
      ],
    });
    expect(screen.getByText('Bench references not found')).toBeInTheDocument();
    expect(screen.getByText('Saleae Logic 8 was not found on the bench')).toBeInTheDocument();
  });

  it('shows no bench warning when nothing needs attention', () => {
    renderReview();
    expect(screen.queryByText('Bench degraded')).not.toBeInTheDocument();
    expect(screen.queryByText('Bench references not found')).not.toBeInTheDocument();
  });

  // D12: the checklist is a wiring instruction, not a list of labels — the detail text
  // is the part that tells the operator which pin to touch.
  it('renders each checklist line with its detail text, not just its label', () => {
    renderReview();
    const lines = screen
      .getAllByRole('checkbox')
      .map((box) => box.closest('label') as HTMLElement);
    expect(lines).toHaveLength(CHECKLIST.length);
    CHECKLIST.forEach((item, index) => {
      expect(lines[index]).toHaveTextContent(item.label);
      expect(lines[index]).toHaveTextContent(item.detail);
    });
  });

  it('returns to the composer via Edit task', async () => {
    const user = userEvent.setup();
    const { onEditTask } = renderReview();
    await user.click(screen.getByRole('button', { name: 'Edit task' }));
    expect(onEditTask).toHaveBeenCalledTimes(1);
  });
});

// Sprint 7 P0 (§7.2 v2.3): the checklist as a VISIBLE safety gate — live
// progress line, dynamic Approve copy, and the completion check icon.
describe('visible safety gate (Sprint 7 P0)', () => {
  it('shows the live progress line and updates it as lines are confirmed', async () => {
    const user = userEvent.setup();
    renderReview();
    expect(screen.getByText('0 of 3 bench connections confirmed')).toBeInTheDocument();

    const boxes = screen.getAllByRole('checkbox');
    await user.click(boxes[0] as HTMLElement);
    expect(screen.getByText('1 of 3 bench connections confirmed')).toBeInTheDocument();
    await user.click(boxes[1] as HTMLElement);
    await user.click(boxes[2] as HTMLElement);
    expect(screen.getByText('3 of 3 bench connections confirmed')).toBeInTheDocument();
  });

  it('the disabled primary says why: "Approve Plan · N/M confirmed", live', async () => {
    const user = userEvent.setup();
    renderReview();
    expect(screen.getByRole('button', { name: 'Approve Plan · 0/3 confirmed' })).toBeDisabled();

    await user.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    expect(screen.getByRole('button', { name: 'Approve Plan · 1/3 confirmed' })).toBeDisabled();
  });

  it('at completion the label is plain "Approve Plan" with the check icon', async () => {
    const user = userEvent.setup();
    renderReview();
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    const approve = screen.getByRole('button', { name: 'Approve Plan' });
    expect(approve).toBeEnabled();
    expect(within(approve).getByTestId('approve-plan-check')).toBeInTheDocument();
  });

  it('no checklist → plain label, no count, no icon', () => {
    renderReview({ checklist: [] });
    const approve = screen.getByRole('button', { name: 'Approve Plan' });
    expect(screen.queryByTestId('approve-plan-check')).not.toBeInTheDocument();
    expect(approve).toBeEnabled();
  });

  it('the risk summary carries the amber rail only when a medium+ risk step exists', () => {
    renderReview();
    const summary = screen.getByText('One medium-risk hardware action.').closest('div');
    expect(summary?.className).toContain('border-warn');
  });

  it('an all-low plan renders the risk summary without the amber rail', () => {
    renderReview({
      plan: PLAN.map((step) => ({ ...step, riskLevel: 'low' as const })),
      riskSummary: 'All steps are low risk.',
    });
    const summary = screen.getByText('All steps are low risk.').closest('div');
    expect(summary?.className).not.toContain('border-warn');
  });
});
