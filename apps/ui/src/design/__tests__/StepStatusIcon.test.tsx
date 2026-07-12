import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { StepStatusIcon } from '../StepStatusIcon';

function renderIcon(status: Parameters<typeof StepStatusIcon>[0]['status']) {
  const { container } = render(<StepStatusIcon status={status} />);
  const svg = container.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg!;
}

// D14 reservation: green fill on the succeeded glyph only, red fill on the
// failed glyph only; active uses the accent; pending/skipped stay neutral.
describe('StepStatusIcon (D14 mapping)', () => {
  it('succeeded is the only glyph filled green', () => {
    const svg = renderIcon('succeeded');
    expect(svg.querySelector('circle')!.getAttribute('fill')).toBe('var(--color-pass)');
    for (const status of ['pending', 'active', 'failed', 'skipped'] as const) {
      const other = renderIcon(status);
      expect(other.innerHTML).not.toContain('--color-pass');
    }
  });

  it('failed is the only glyph filled red', () => {
    const svg = renderIcon('failed');
    expect(svg.querySelector('circle')!.getAttribute('fill')).toBe('var(--color-fail)');
    for (const status of ['pending', 'active', 'succeeded', 'skipped'] as const) {
      const other = renderIcon(status);
      expect(other.innerHTML).not.toContain('--color-fail');
    }
  });

  it('active uses the accent with a pulsing ring', () => {
    const svg = renderIcon('active');
    expect(svg.innerHTML).toContain('--color-accent');
    expect(svg.querySelector('.animate-step-pulse')).not.toBeNull();
  });

  it('pending and skipped stay neutral — no accent, no reserved colors', () => {
    for (const status of ['pending', 'skipped'] as const) {
      const svg = renderIcon(status);
      expect(svg.innerHTML).not.toContain('--color-accent');
      expect(svg.innerHTML).not.toContain('--color-warn');
    }
  });

  it('is decorative: aria-hidden with a data-status hook for callers', () => {
    const svg = renderIcon('pending');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('data-status')).toBe('pending');
  });
});
