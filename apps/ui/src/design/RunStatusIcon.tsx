import type { RunStatus } from '@boardex/contract';
import { ActiveGlyph, AttentionGlyph, CheckGlyph, CrossGlyph, RingGlyph } from './glyphs';

/**
 * Run-status glyph (T6.1b): the shape companion to Badge's status mapping, for
 * dense surfaces (sidebar Recent, the Home table) where a run's state should
 * scan without reading. The color derivation is EXACTLY Badge's D14 one:
 * green check = completed only, red cross = failed/stopped only, amber
 * attention = exactly the states where a human action exists (plan_ready,
 * awaiting_approval), accent = the agent working (running, diagnosing),
 * neutral ring = draft/planning.
 */
export interface RunStatusIconProps {
  status: RunStatus;
  /** Square size in px. */
  sizePx?: number;
  className?: string;
}

function glyph(status: RunStatus) {
  switch (status) {
    case 'draft':
    case 'planning':
      return <RingGlyph />;
    case 'running':
    case 'diagnosing':
      return <ActiveGlyph />;
    case 'plan_ready':
    case 'awaiting_approval':
      return <AttentionGlyph />;
    case 'completed':
      return <CheckGlyph />;
    case 'failed':
    case 'stopped':
      return <CrossGlyph />;
  }
}

export function RunStatusIcon({ status, sizePx = 14, className = '' }: RunStatusIconProps) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={sizePx}
      height={sizePx}
      aria-hidden="true"
      data-status={status}
      className={className}
    >
      {glyph(status)}
    </svg>
  );
}
