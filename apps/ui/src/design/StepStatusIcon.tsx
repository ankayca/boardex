import type { StepStatus } from '@boardex/contract';

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

const STROKE_ON_FILL = 'var(--color-bg-panel)';

function glyph(status: StepStatus) {
  switch (status) {
    case 'pending':
      return (
        <circle
          cx="7"
          cy="7"
          r="5.75"
          fill="var(--color-bg-panel)"
          stroke="var(--color-border-strong)"
          strokeWidth="1.5"
        />
      );
    case 'active':
      return (
        <>
          <circle
            className="animate-step-pulse"
            cx="7"
            cy="7"
            r="5.75"
            fill="var(--color-bg-panel)"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
          />
          <circle cx="7" cy="7" r="2.5" fill="var(--color-accent)" />
        </>
      );
    case 'succeeded':
      return (
        <>
          <circle cx="7" cy="7" r="6.5" fill="var(--color-pass)" />
          <path
            d="M4.3 7.3l1.9 1.9 3.5-3.9"
            fill="none"
            stroke={STROKE_ON_FILL}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'failed':
      return (
        <>
          <circle cx="7" cy="7" r="6.5" fill="var(--color-fail)" />
          <path
            d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2"
            fill="none"
            stroke={STROKE_ON_FILL}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </>
      );
    case 'skipped':
      return (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.75"
            fill="var(--color-neutral-badge-bg)"
            stroke="var(--color-border-strong)"
            strokeWidth="1.5"
          />
          <path
            d="M4.5 7h5"
            stroke="var(--color-neutral-badge)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </>
      );
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
