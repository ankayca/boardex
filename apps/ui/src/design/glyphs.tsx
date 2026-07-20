/**
 * Shared 14×14 status glyph fragments for StepStatusIcon and RunStatusIcon.
 * Internal to design/ — the icons are the public surface. Token colors only;
 * strokes on solid fills use the panel white.
 */

export const GLYPH_STROKE_ON_FILL = 'var(--color-surface)';

/** Hollow ring — the not-yet states (pending / draft / planning). */
export function RingGlyph({ fill = 'var(--color-surface)' }: { fill?: string }) {
  return (
    <circle
      cx="7"
      cy="7"
      r="5.75"
      fill={fill}
      stroke="var(--color-border-strong)"
      strokeWidth="1.5"
    />
  );
}

/** Accent ring + core, pulsing — something is actively working. */
export function ActiveGlyph() {
  return (
    <>
      <circle
        className="animate-step-pulse"
        cx="7"
        cy="7"
        r="5.75"
        fill="var(--color-surface)"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
      />
      <circle cx="7" cy="7" r="2.5" fill="var(--color-accent)" />
    </>
  );
}

/** Green check — success terminals ONLY (D14). */
export function CheckGlyph() {
  return (
    <>
      <circle cx="7" cy="7" r="6.5" fill="var(--color-pass)" />
      <path
        d="M4.3 7.3l1.9 1.9 3.5-3.9"
        fill="none"
        stroke={GLYPH_STROKE_ON_FILL}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

/** Red cross — fail/stop terminals ONLY (D14). */
export function CrossGlyph() {
  return (
    <>
      <circle cx="7" cy="7" r="6.5" fill="var(--color-fail)" />
      <path
        d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2"
        fill="none"
        stroke={GLYPH_STROKE_ON_FILL}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </>
  );
}

/** Neutral dash — skipped. */
export function DashGlyph() {
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

/** Amber exclamation — a human action exists ONLY (D14: approval-needed). */
export function AttentionGlyph() {
  return (
    <>
      <circle cx="7" cy="7" r="6.5" fill="var(--color-warn)" />
      <path
        d="M7 3.8v3.9"
        fill="none"
        stroke={GLYPH_STROKE_ON_FILL}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.2" r="0.9" fill={GLYPH_STROKE_ON_FILL} />
    </>
  );
}
