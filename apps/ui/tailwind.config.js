/**
 * Tailwind theme extension — EXACT tokens from BIBLE §6.1.
 * Colors are wired to CSS variables declared in src/index.css. Do not add colors
 * outside this set (green = pass only, red = fail/stop only, amber = approval/warn only).
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
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        meta: '13px',
        body: '14px',
        section: '16px',
        page: '20px',
        composer: '24px',
      },
      borderRadius: {
        card: 'var(--radius-card)',
        button: 'var(--radius-button)',
      },
      boxShadow: {
        subtle: 'var(--shadow-subtle)',
      },
    },
  },
  plugins: [],
};
