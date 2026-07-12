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
