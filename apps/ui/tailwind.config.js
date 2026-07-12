/**
 * Tailwind theme extension — EXACT tokens from BIBLE §6.1, evolved by T6.1
 * (type rhythm, elevation levels, motion). Colors are wired to CSS variables
 * declared in src/index.css. Do not add colors outside this set (green = pass
 * only, red = fail/stop only, amber = approval/warn only).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-app': 'var(--color-bg-app)',
        'bg-panel': 'var(--color-bg-panel)',
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
      // §6.1 scale with T6.1 rhythm: explicit line-heights on every step,
      // negative tracking on display sizes, positive tracking on the 11px
      // uppercase label step (badges, chips).
      fontSize: {
        label: ['11px', { lineHeight: '16px', letterSpacing: '0.05em' }],
        meta: ['13px', { lineHeight: '18px' }],
        body: ['14px', { lineHeight: '20px' }],
        section: ['16px', { lineHeight: '22px', letterSpacing: '-0.01em' }],
        page: ['20px', { lineHeight: '26px', letterSpacing: '-0.017em' }],
        composer: ['24px', { lineHeight: '32px', letterSpacing: '-0.019em' }],
      },
      borderRadius: {
        card: 'var(--radius-card)',
        button: 'var(--radius-button)',
      },
      boxShadow: {
        subtle: 'var(--shadow-subtle)',
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
      },
      transitionDuration: {
        fast: 'var(--motion-fast)',
        medium: 'var(--motion-medium)',
        gentle: 'var(--motion-gentle)',
      },
      transitionTimingFunction: {
        motion: 'var(--ease-standard)',
        entrance: 'var(--ease-entrance)',
      },
    },
  },
  plugins: [],
};
