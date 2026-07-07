import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../Badge';

describe('Badge risk mapping (BIBLE §6.2)', () => {
  it('low renders neutral', () => {
    render(<Badge kind="risk" value="low" />);
    const badge = screen.getByText('Low');
    expect(badge).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
  });

  it('medium renders amber outline with no solid fill', () => {
    render(<Badge kind="risk" value="medium" />);
    const badge = screen.getByText('Medium');
    expect(badge).toHaveClass('border-warn', 'text-warn');
    expect(badge.classList.contains('bg-warn')).toBe(false);
  });

  it('high renders amber solid', () => {
    render(<Badge kind="risk" value="high" />);
    const badge = screen.getByText('High');
    expect(badge).toHaveClass('bg-warn', 'text-white');
  });

  it('critical renders red solid', () => {
    render(<Badge kind="risk" value="critical" />);
    const badge = screen.getByText('Critical');
    expect(badge).toHaveClass('bg-fail', 'text-white');
  });
});

describe('Badge verdict mapping (BIBLE §6.2)', () => {
  it('pass renders green on green tint', () => {
    render(<Badge kind="verdict" value="pass" />);
    const badge = screen.getByText('PASS');
    expect(badge).toHaveClass('bg-pass-bg', 'text-pass');
  });

  it('fail renders red on red tint', () => {
    render(<Badge kind="verdict" value="fail" />);
    const badge = screen.getByText('FAIL');
    expect(badge).toHaveClass('bg-fail-bg', 'text-fail');
  });

  it('needs_review renders amber on amber tint', () => {
    render(<Badge kind="verdict" value="needs_review" />);
    const badge = screen.getByText('NEEDS REVIEW');
    expect(badge).toHaveClass('bg-warn-bg', 'text-warn');
  });
});

describe('Badge status mapping (D14 semantic reservation)', () => {
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

  it('states needing the human render amber', () => {
    render(<Badge kind="status" value="awaiting_approval" />);
    render(<Badge kind="status" value="plan_ready" />);
    render(<Badge kind="status" value="diagnosing" />);
    expect(screen.getByText('Awaiting approval')).toHaveClass('bg-warn-bg', 'text-warn');
    expect(screen.getByText('Plan ready')).toHaveClass('bg-warn-bg', 'text-warn');
    expect(screen.getByText('Diagnosing')).toHaveClass('bg-warn-bg', 'text-warn');
  });

  it('working states render neutral — no decorative color', () => {
    render(<Badge kind="status" value="draft" />);
    render(<Badge kind="status" value="planning" />);
    render(<Badge kind="status" value="running" />);
    expect(screen.getByText('Draft')).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
    expect(screen.getByText('Planning')).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
    expect(screen.getByText('Running')).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
  });
});
