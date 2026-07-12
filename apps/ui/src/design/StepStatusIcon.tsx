import type { StepStatus } from '@boardex/contract';
import { ActiveGlyph, CheckGlyph, CrossGlyph, DashGlyph, RingGlyph } from './glyphs';

/**
 * Timeline status iconography (T6.1): one glyph per StepStatus so a timeline
 * scans by shape, not color alone. Inline SVG, token colors only.
 *
 * D14 reservation holds absolutely: the green check marks succeeded only, the
 * red cross failed only. Active is the accent (the agent working — not a
 * verdict); pending and skipped stay neutral. The active ring pulses gently;
 * prefers-reduced-motion halts it via the global override in index.css.
 */
export interface StepStatusIconProps {
  status: StepStatus;
  /** Square size in px; defaults to the 14px timeline marker size. */
  sizePx?: number;
  className?: string;
}

function glyph(status: StepStatus) {
  switch (status) {
    case 'pending':
      return <RingGlyph />;
    case 'active':
      return <ActiveGlyph />;
    case 'succeeded':
      return <CheckGlyph />;
    case 'failed':
      return <CrossGlyph />;
    case 'skipped':
      return <DashGlyph />;
  }
}

export function StepStatusIcon({ status, sizePx = 14, className = '' }: StepStatusIconProps) {
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
