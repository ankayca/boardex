// Token-migration completeness (BIBLE §6.1 v2.3, Sprint 7 P0): the old visual
// system is RETIRED, not aliased. This test greps the entire UI source for the
// pre-v2.3 hex values and token names — one surviving consumer is a failure —
// and pins the new palette to the exact §6.1 values so a drive-by "adjustment"
// of a semantic color breaks loudly.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UI_ROOT = join(__dirname, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(tsx?|css|js|html)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

// This file carries the denylist itself — exclude it from its own scan.
const FILES = [
  ...sourceFiles(join(UI_ROOT, 'src')).filter((file) => file !== __filename),
  join(UI_ROOT, 'tailwind.config.js'),
  join(UI_ROOT, 'index.html'),
];

// The retired §6.1 pre-v2.3 palette, verbatim from the old token block.
const RETIRED_HEX = [
  'fafaf9', // old app background
  'e7e5e4', // old border
  'd6d3d1', // old strong border
  '1c1917', // old text primary
  '57534e', // old text secondary
  '4f46e5', // old accent (indigo-600)
  '4338ca', // old accent hover
  '16a34a', // old pass
  'f0fdf4', // old pass tint
  'dc2626', // old fail
  'fef2f2', // old fail tint
  'd97706', // old warn
  'fffbeb', // old warn tint
  '78716c', // old neutral badge
  'f5f5f4', // old neutral badge tint
];

// Retired token/utility names. Word-boundary guards: `rounded-button` must not
// match nothing else, `bg-bg-*` were the old surface utilities.
const RETIRED_NAMES = [
  '--color-bg-app',
  '--color-bg-panel',
  'bg-bg-app',
  'bg-bg-panel',
  '--radius-button',
  'rounded-button',
  '--shadow-subtle',
  'shadow-subtle',
];

// The retired pre-v2.3 geometry (§6.1: "240px sidebar, 340px rail … are retired —
// nothing in the codebase may reference them"), incl. the old 1280px workspace
// breakpoint (v2.3 keys the split on 1208px of CONTENT width). Comments count:
// a stale number in a comment is exactly the drift this denylist exists to catch.
const RETIRED_GEOMETRY = [
  '340px', // old right rail
  '240px', // old sidebar
  '1280px', // old workspace breakpoint
];

describe('§6.1 v2.3 token migration', () => {
  it('no retired hex value survives anywhere in the UI source', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const hex of RETIRED_HEX) {
        if (text.includes(hex)) offenders.push(`${file}: #${hex}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no retired token or utility name survives anywhere in the UI source', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const name of RETIRED_NAMES) {
        if (text.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no retired geometry value survives anywhere in the UI source', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const value of RETIRED_GEOMETRY) {
        if (text.includes(value)) offenders.push(`${file}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('index.css declares exactly the §6.1 v2.3 palette', () => {
    const css = readFileSync(join(UI_ROOT, 'src', 'index.css'), 'utf8');
    const expected: Record<string, string> = {
      '--color-canvas': '#f7f7f8',
      '--color-nav': '#fbfbfc',
      '--color-surface': '#ffffff',
      '--color-border': '#e2e3e7',
      '--color-border-strong': '#d2d4da',
      '--color-text-primary': '#17171a',
      '--color-text-secondary': '#5c6068',
      '--color-accent': '#5b4cf0',
      '--color-accent-hover': '#4a3bd8',
      '--color-accent-bg': '#ecebfb',
      '--color-pass': '#168a4a',
      '--color-pass-bg': '#e8f5ee',
      '--color-fail': '#c73535',
      '--color-fail-bg': '#fbeded',
      '--color-warn': '#a86d00',
      '--color-warn-bg': '#faf3e4',
      '--color-neutral-badge': '#3f434b',
      '--color-neutral-badge-bg': '#e9eaee',
    };
    for (const [token, value] of Object.entries(expected)) {
      expect(css, token).toContain(`${token}: ${value}`);
    }
    expect(css).toContain('--color-scrim: rgba(23, 23, 26, 0.35)');
    expect(css).toContain('--radius-card: 8px');
    expect(css).toContain('--radius-control: 6px');
  });

  it('index.css declares exactly the §6.1 motion tokens and eases', () => {
    const css = readFileSync(join(UI_ROOT, 'src', 'index.css'), 'utf8');
    const expected: Record<string, string> = {
      '--motion-fast': '120ms',
      '--motion-medium': '200ms',
      '--motion-gentle': '360ms',
      '--motion-morph': '280ms',
      '--motion-arrival': '700ms',
      '--motion-ambient': '2s',
      '--ease-standard': 'cubic-bezier(0.2, 0, 0, 1)',
      '--ease-entrance': 'cubic-bezier(0.16, 1, 0.3, 1)',
    };
    for (const [token, value] of Object.entries(expected)) {
      expect(css, token).toContain(`${token}: ${value}`);
    }
  });

  // Sprint 7 P1 #14: reduced motion re-verified. The one global rule collapses
  // BOTH animations and transitions to near-zero — so everything this pass added
  // (the cited-source arrival wash, the on-token hover transitions) settles
  // instantly for a reduced-motion user without any per-component handling.
  it('index.css collapses all animation + transition motion under prefers-reduced-motion', () => {
    const css = readFileSync(join(UI_ROOT, 'src', 'index.css'), 'utf8');
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('@media (prefers-reduced-motion: reduce)');
    // Applies to every element and pseudo-element, not a hand-listed set.
    expect(block).toContain('*,');
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it('the geometry tokens hold: sidebar 208px, rail 320px, breakpoint 1208px', () => {
    const css = readFileSync(join(UI_ROOT, 'src', 'index.css'), 'utf8');
    expect(css).toContain('min-width: 1208px');
    expect(css).toContain('minmax(560px, 1fr) 320px');
    const sidebar = readFileSync(join(UI_ROOT, 'src', 'shell', 'Sidebar.tsx'), 'utf8');
    expect(sidebar).toContain("'w-14' : 'w-52'");
  });
});
