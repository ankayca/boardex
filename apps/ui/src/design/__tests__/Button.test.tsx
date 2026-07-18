import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '../Button';

describe('Button (T6.1c additions)', () => {
  // outline-danger: quiet red outline at rest — the solid fill is gated behind
  // hover/active intent (enabled: variants), never the resting state.
  it('outline-danger rests as red outline, not solid red', () => {
    render(<Button variant="outline-danger">Stop Run</Button>);
    const button = screen.getByRole('button', { name: 'Stop Run' });
    expect(button).toHaveClass('border-fail', 'text-fail', 'bg-transparent');
    expect(button.classList.contains('bg-fail')).toBe(false);
  });

  it('disabled buttons keep 60% presence', () => {
    render(
      <Button variant="primary" disabled>
        Create Run Plan
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Create Run Plan' })).toHaveClass(
      'disabled:opacity-60',
    );
  });
});

describe('Button (§6.2 v2.3 system)', () => {
  it('standard buttons are 36px; gate size is 40px and opt-in', () => {
    render(<Button>Standard</Button>);
    render(<Button size="gate">Approve &amp; Continue</Button>);
    expect(screen.getByRole('button', { name: 'Standard' })).toHaveClass('h-9');
    expect(screen.getByRole('button', { name: 'Approve & Continue' })).toHaveClass('h-10');
  });

  it('secondary is a white surface with the strong neutral border', () => {
    render(<Button variant="secondary">Review Diff</Button>);
    expect(screen.getByRole('button', { name: 'Review Diff' })).toHaveClass(
      'border-border-strong',
      'bg-surface',
      'text-text-primary',
    );
  });

  it('tertiary-danger rests neutral — red arrives only with hover/focus intent', () => {
    render(<Button variant="tertiary-danger">Reject</Button>);
    const button = screen.getByRole('button', { name: 'Reject' });
    expect(button).toHaveClass('text-text-secondary');
    // No resting red, no box: not a danger fill, not a bordered secondary.
    expect(button.classList.contains('text-fail')).toBe(false);
    expect(button.classList.contains('bg-fail')).toBe(false);
    expect(button.className).not.toContain('border-');
  });
});
