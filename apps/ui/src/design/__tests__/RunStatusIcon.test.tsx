import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { RunStatus } from '@boardex/contract';
import { RunStatusIcon } from '../RunStatusIcon';

function renderIcon(status: RunStatus) {
  const { container } = render(<RunStatusIcon status={status} />);
  const svg = container.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg!;
}

// The color derivation is exactly Badge's D14 status mapping — asserted per
// reserved color so a glyph can never leak green/red/amber onto the wrong state.
describe('RunStatusIcon (D14 mapping)', () => {
  it('completed is the only green glyph', () => {
    expect(renderIcon('completed').innerHTML).toContain('--color-pass');
    const others: RunStatus[] = [
      'draft',
      'planning',
      'plan_ready',
      'running',
      'awaiting_approval',
      'diagnosing',
      'failed',
      'stopped',
    ];
    for (const status of others) {
      expect(renderIcon(status).innerHTML).not.toContain('--color-pass');
    }
  });

  it('failed and stopped are the only red glyphs', () => {
    expect(renderIcon('failed').innerHTML).toContain('--color-fail');
    expect(renderIcon('stopped').innerHTML).toContain('--color-fail');
    const others: RunStatus[] = [
      'draft',
      'planning',
      'plan_ready',
      'running',
      'awaiting_approval',
      'diagnosing',
      'completed',
    ];
    for (const status of others) {
      expect(renderIcon(status).innerHTML).not.toContain('--color-fail');
    }
  });

  it('amber marks exactly the states where a human action exists', () => {
    expect(renderIcon('plan_ready').innerHTML).toContain('--color-warn');
    expect(renderIcon('awaiting_approval').innerHTML).toContain('--color-warn');
    const others: RunStatus[] = [
      'draft',
      'planning',
      'running',
      'diagnosing',
      'completed',
      'failed',
      'stopped',
    ];
    for (const status of others) {
      expect(renderIcon(status).innerHTML).not.toContain('--color-warn');
    }
  });

  it('working states use the accent; draft/planning stay neutral', () => {
    expect(renderIcon('running').innerHTML).toContain('--color-accent');
    expect(renderIcon('diagnosing').innerHTML).toContain('--color-accent');
    expect(renderIcon('draft').innerHTML).not.toContain('--color-accent');
    expect(renderIcon('planning').innerHTML).not.toContain('--color-accent');
  });

  it('is decorative: aria-hidden with a data-status hook', () => {
    const svg = renderIcon('running');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('data-status')).toBe('running');
  });
});
