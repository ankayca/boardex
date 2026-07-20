/**
 * Tailwind theme extension — EXACT tokens from BIBLE §6.1 v2.3 (Sprint 7 P0
 * visual system). Colors are wired to CSS variables declared in src/index.css.
 * Do not add colors outside this set (green = pass only, red = fail/stop only,
 * amber = approval/warn only).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--color-canvas)',
        nav: 'var(--color-nav)',
        surface: 'var(--color-surface)',
        border: 'var(--color-border)',
        'border-strong': 'var(--color-border-strong)',
        'text-primary': 'var(--color-text-primary)',
        'text-secondary': 'var(--color-text-secondary)',
        accent: 'var(--color-accent)',
        'accent-hover': 'var(--color-accent-hover)',
        pass: 'var(--color-pass)',
        'pass-bg': 'var(--color-pass-bg)',
        fail: 'var(--color-fail)',
        'fail-bg': 'var(--color-fail-bg)',
        warn: 'var(--color-warn)',
        'warn-bg': 'var(--color-warn-bg)',
        'neutral-badge': 'var(--color-neutral-badge)',
        'neutral-badge-bg': 'var(--color-neutral-badge-bg)',
        scrim: 'var(--color-scrim)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      // §6.1 v2.3 ladder — explicit line-heights per step. `label` (11px) is
      // reserved for the run-state and risk capsules; every other state-bearing
      // text sits at metadata (12px) or above. Card/step titles are the body
      // step with font-semibold — weight IS the step.
      fontSize: {
        label: ['11px', { lineHeight: '16px', letterSpacing: '0.05em' }],
        metadata: ['12px', { lineHeight: '16px' }],
        code: ['12.5px', { lineHeight: '19px' }],
        meta: ['13px', { lineHeight: '18px' }],
        body: ['14px', { lineHeight: '20px' }],
        section: ['15px', { lineHeight: '20px', letterSpacing: '-0.01em' }],
        page: ['22px', { lineHeight: '28px', letterSpacing: '-0.017em' }],
        composer: ['24px', { lineHeight: '32px', letterSpacing: '-0.019em' }],
      },
      borderRadius: {
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
      },
      boxShadow: {
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
      },
      transitionDuration: {
        fast: 'var(--motion-fast)',
        medium: 'var(--motion-medium)',
        gentle: 'var(--motion-gentle)',
        morph: 'var(--motion-morph)',
      },
      transitionTimingFunction: {
        motion: 'var(--ease-standard)',
        entrance: 'var(--ease-entrance)',
      },
    },
  },
  plugins: [],
};
