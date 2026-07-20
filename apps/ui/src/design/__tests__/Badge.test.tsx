import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../Badge';

describe('Badge risk capsule (BIBLE §6.2 v2.3)', () => {
  it('low renders a FILLED neutral capsule with dark text — never disabled-looking', () => {
    render(<Badge kind="risk" value="low" />);
    const badge = screen.getByText('Low');
    expect(badge).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
    expect(badge.classList.contains('opacity-50')).toBe(false);
  });

  it('medium renders amber tint, no solid amber fill', () => {
    render(<Badge kind="risk" value="medium" />);
    const badge = screen.getByText('Medium');
    expect(badge).toHaveClass('bg-warn-bg', 'text-warn');
    expect(badge.classList.contains('bg-warn')).toBe(false);
  });

  it('high renders amber solid with text-primary for contrast', () => {
    render(<Badge kind="risk" value="high" />);
    const badge = screen.getByText('High');
    // White on the amber fill fails small-text contrast — high uses text-primary.
    expect(badge).toHaveClass('bg-warn', 'text-text-primary');
    expect(badge.classList.contains('text-white')).toBe(false);
  });

  it('critical renders red solid', () => {
    render(<Badge kind="risk" value="critical" />);
    const badge = screen.getByText('Critical');
    expect(badge).toHaveClass('bg-fail', 'text-white');
  });

  it('risk capsules use the 11px label step', () => {
    render(<Badge kind="risk" value="low" />);
    expect(screen.getByText('Low')).toHaveClass('text-label', 'uppercase');
  });
});

describe('Badge verdict class (BIBLE §6.2 v2.3 — icon-led, 12px, mixed case)', () => {
  it('pass renders green on green tint with the check icon present', () => {
    render(<Badge kind="verdict" value="pass" />);
    const badge = screen.getByText('Pass');
    expect(badge).toHaveClass('bg-pass-bg', 'text-pass', 'text-metadata');
    expect(badge.querySelector('[data-verdict-icon="pass"]')).not.toBeNull();
  });

  it('fail renders red on red tint with the cross icon present', () => {
    render(<Badge kind="verdict" value="fail" />);
    const badge = screen.getByText('Fail');
    expect(badge).toHaveClass('bg-fail-bg', 'text-fail');
    expect(badge.querySelector('[data-verdict-icon="fail"]')).not.toBeNull();
  });

  it('needs_review renders amber on amber tint with the attention icon', () => {
    render(<Badge kind="verdict" value="needs_review" />);
    const badge = screen.getByText('Needs review');
    expect(badge).toHaveClass('bg-warn-bg', 'text-warn');
    expect(badge.querySelector('[data-verdict-icon="needs_review"]')).not.toBeNull();
  });

  it('not_recorded renders NEUTRAL gray with the dash icon — never red', () => {
    render(<Badge kind="verdict" value="not_recorded" />);
    const badge = screen.getByText('Not recorded');
    expect(badge).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
    expect(badge.classList.contains('text-fail')).toBe(false);
    expect(badge.classList.contains('bg-fail-bg')).toBe(false);
    expect(badge.querySelector('[data-verdict-icon="not_recorded"]')).not.toBeNull();
  });

  it('every verdict badge carries an icon — color is never the only signal', () => {
    for (const value of ['pass', 'fail', 'needs_review', 'not_recorded'] as const) {
      const { container, unmount } = render(<Badge kind="verdict" value={value} />);
      expect(container.querySelector('[data-verdict-icon]'), value).not.toBeNull();
      unmount();
    }
  });

  it('verdict text sits at the 12px metadata step, not the 11px label step', () => {
    render(<Badge kind="verdict" value="pass" />);
    const badge = screen.getByText('Pass');
    expect(badge).toHaveClass('text-metadata');
    expect(badge.classList.contains('text-label')).toBe(false);
    expect(badge.classList.contains('uppercase')).toBe(false);
  });
});

describe('Badge run-state capsule (D14 semantic reservation)', () => {
  it('completed is the only green status', () => {
    render(<Badge kind="status" value="completed" />);
    expect(screen.getByText('Completed')).toHaveClass('bg-pass-bg', 'text-pass');
  });

  it('failed and stopped render red', () => {
    render(<Badge kind="status" value="failed" />);
    render(<Badge kind="status" value="stopped" />);
    expect(screen.getByText('Failed')).toHaveClass('bg-fail-bg', 'text-fail');
    expect(screen.getByText('Stopped')).toHaveClass('bg-fail-bg', 'text-fail');
  });

  it('amber marks exactly the states where a human action exists', () => {
    render(<Badge kind="status" value="awaiting_approval" />);
    render(<Badge kind="status" value="plan_ready" />);
    expect(screen.getByText('Awaiting approval')).toHaveClass('bg-warn-bg', 'text-warn');
    expect(screen.getByText('Plan ready')).toHaveClass('bg-warn-bg', 'text-warn');
  });

  it('working states render neutral — no decorative color (diagnosing included)', () => {
    render(<Badge kind="status" value="draft" />);
    render(<Badge kind="status" value="planning" />);
    render(<Badge kind="status" value="running" />);
    // diagnosing is the agent acting, not the human — neutral, not amber.
    render(<Badge kind="status" value="diagnosing" />);
    expect(screen.getByText('Draft')).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
    expect(screen.getByText('Planning')).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
    expect(screen.getByText('Running')).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
    expect(screen.getByText('Diagnosing')).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
    expect(screen.getByText('Diagnosing').classList.contains('text-warn')).toBe(false);
  });

  it('run-state capsules use the 11px label step — the reserved machine label', () => {
    render(<Badge kind="status" value="running" />);
    expect(screen.getByText('Running')).toHaveClass('text-label', 'uppercase');
  });
});
