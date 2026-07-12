// ReportView (§7.6) renders the runner-authored report_md with house typography and
// turns artifact-label references into evidence deep links. These cases run against
// the REAL fixture report + its reduced artifacts (the same bytes the mock runner
// serves), so the presentation can never drift from the fixture. The deep-link law
// is asserted both ways: a label present in RunView.artifacts becomes a link; an
// absent one stays plain text — fail-closed, no dead href.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { reduceRun, type Artifact, type RunView, type WireEvent } from '@boardex/contract';
import { ReportView } from './ReportView';

// Resolve fixtures from the package cwd (apps/ui) rather than new URL(…,
// import.meta.url): Vite statically rewrites the latter as an asset reference, which
// a dynamic ${rel} segment breaks. These are the same bytes the mock runner serves.
const fixtureFile = (rel: string): string =>
  readFileSync(resolve(process.cwd(), '../../packages/contract/fixtures', rel), 'utf8');

const REPORT_MD = fixtureFile('artifacts/art_report.md');

const fixtureView = (): RunView => {
  const events = fixtureFile('bme280_run_001.jsonl')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line).event as WireEvent);
  const view = reduceRun(events);
  if (!view) throw new Error('fixture did not reduce to a view');
  return view;
};

const renderView = (markdown: string, artifacts: readonly Artifact[], runId = 'run_bme280_001') =>
  render(
    <MemoryRouter>
      <ReportView markdown={markdown} runId={runId} artifacts={artifacts} />
    </MemoryRouter>,
  );

describe('ReportView against the real fixture', () => {
  it('renders the report heading and the measurement results table', () => {
    const view = fixtureView();
    renderView(REPORT_MD, view.artifacts);

    expect(
      screen.getByRole('heading', { level: 1, name: /Validation Report — BME280 bring-up/ }),
    ).toBeInTheDocument();

    // The measurement results table renders with its header and a requirement row.
    const clockCode = screen.getByText('i2c_clock');
    const table = clockCode.closest('table');
    expect(table).not.toBeNull();
    expect(within(table as HTMLTableElement).getByText('Requirement')).toBeInTheDocument();
    expect(within(table as HTMLTableElement).getByText('Expected')).toBeInTheDocument();
  });

  it('turns a bold artifact-label reference into an evidence deep link', () => {
    const view = fixtureView();
    renderView(REPORT_MD, view.artifacts);

    // "Code diff — BME280 driver (iteration 1)" is an artifact label; its id is the
    // one the reducer carries for that label.
    const artifactId = view.artifacts.find(
      (a) => a.label === 'Code diff — BME280 driver (iteration 1)',
    )?.id;
    expect(artifactId).toBeDefined();

    const link = screen.getAllByRole('link', {
      name: 'Code diff — BME280 driver (iteration 1)',
    })[0];
    expect(link).toHaveAttribute(
      'href',
      `/runs/run_bme280_001/evidence?artifact=${artifactId}`,
    );
  });

  it('turns a plain-text label cell in the artifacts index into a deep link', () => {
    const view = fixtureView();
    renderView(REPORT_MD, view.artifacts);
    const serialId = view.artifacts.find((a) => a.label === 'Serial log (iteration 2)')?.id;
    // The label appears in the results table (plain text) and the artifacts index —
    // both resolve to the same evidence link.
    const links = screen.getAllByRole('link', { name: 'Serial log (iteration 2)' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', `/runs/run_bme280_001/evidence?artifact=${serialId}`);
    }
  });
});

describe('ReportView verdict column stays uncolored (D14 — reserved colors never decorate)', () => {
  it('renders PASS verdicts in the measurement table with house text tokens, no pass/fail color anywhere', () => {
    const view = fixtureView();
    const { container } = renderView(REPORT_MD, view.artifacts);

    // The fixture's Verdict column is **PASS** — bold, but never green.
    const verdicts = screen.getAllByText('PASS');
    expect(verdicts.length).toBeGreaterThan(0);
    for (const verdict of verdicts) {
      expect(verdict.className).not.toMatch(/pass|fail|warn/);
    }
    // Nothing in the whole rendered report borrows the reserved status colors.
    expect(
      container.querySelector('.text-pass, .text-fail, .text-warn, .bg-pass-bg, .bg-fail-bg, .bg-warn-bg'),
    ).toBeNull();
  });
});

describe('ReportView table alignment (GFM hints)', () => {
  it('applies left/center/right alignment per column on header and body cells', () => {
    renderView('| L | C | R |\n|:---|:---:|---:|\n| a | b | c |', []);
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers[0]!.className).toContain('text-left');
    expect(headers[1]!.className).toContain('text-center');
    expect(headers[2]!.className).toContain('text-right');
    const cells = within(table).getAllByRole('cell');
    expect(cells[0]!.className).toContain('text-left');
    expect(cells[1]!.className).toContain('text-center');
    expect(cells[2]!.className).toContain('text-right');
  });
});

describe('ReportView link scheme allowlist (fail-closed XSS surface)', () => {
  it.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['protocol-relative //', '//evil.example/phish'],
  ])('renders a %s href as plain text — no anchor, text still visible', (_name, href) => {
    renderView(`See [the details](${href}) here.`, [], 'run_x');
    expect(screen.queryByRole('link', { name: 'the details' })).not.toBeInTheDocument();
    // Fail-closed but never silent: the link text stays visible as plain text.
    expect(screen.getByText('the details')).toBeInTheDocument();
  });

  // WHATWG URL parsing strips tab/LF/CR anywhere and folds \ into /, so these
  // "internal-looking" hrefs actually resolve protocol-relative (verified:
  // new URL('/\\evil.com', origin) === 'https://evil.com/'). Classification must
  // see the normalized form, not the raw text.
  it.each([
    ['backslash /\\', '/\\evil.com'],
    ['tab-obfuscated', '/\t/evil.com'],
    ['CR-obfuscated', '/\r//evil.com'],
  ])('renders a WHATWG-foldable %s href as plain text', (_name, href) => {
    renderView(`See [the details](${href}) here.`, [], 'run_x');
    expect(screen.queryByRole('link', { name: 'the details' })).not.toBeInTheDocument();
    expect(screen.getByText('the details')).toBeInTheDocument();
  });

  it('an LF-obfuscated href never survives to a protocol-relative anchor: the block pass splits lines first', () => {
    // '[x](/\n//evil.com)' cannot parse as one link — parseMarkdown line-splits
    // before inline parsing, and the soft-wrap join yields the href '/ //evil.com':
    // a same-origin path (space, not slash, in second position), which the router
    // then renders with the empty segment collapsed. The \n strip in normalizeHref
    // is defensive depth; the CR case above exercises the identical WHATWG
    // control-char strip directly.
    renderView('See [the details](/\n//evil.com) here.', [], 'run_x');
    const href = screen.getByRole('link', { name: 'the details' }).getAttribute('href') ?? '';
    expect(href).toBe('/ /evil.com');
    expect(href.startsWith('//')).toBe(false);
  });

  it('does not treat percent-escapes as foldable: /%5Cevil.com stays a literal same-origin path', () => {
    // Out of scope for normalization by design: percent-escapes are path DATA,
    // decoded only after URL parsing (verified: new URL('/%5Cevil.com', origin)
    // stays on origin), and react-router does not pre-decode hrefs either — so
    // this renders as an ordinary internal link, not a protocol-relative one.
    renderView('See [the details](/%5Cevil.com) here.', [], 'run_x');
    expect(screen.getByRole('link', { name: 'the details' })).toHaveAttribute(
      'href',
      '/%5Cevil.com',
    );
  });

  it('renders http(s) URLs and app-internal absolute paths as live links', () => {
    renderView(
      '[docs](https://x.dev) and [evidence](/runs/run_x/evidence?artifact=art_1)',
      [],
      'run_x',
    );
    const external = screen.getByRole('link', { name: 'docs' });
    expect(external).toHaveAttribute('href', 'https://x.dev');
    expect(external).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByRole('link', { name: 'evidence' })).toHaveAttribute(
      'href',
      '/runs/run_x/evidence?artifact=art_1',
    );
  });

  it('never uses dangerouslySetInnerHTML: raw HTML in the markdown renders escaped as text', () => {
    renderView('<img src=x onerror=alert(1)> plain **bold**', [], 'run_x');
    // The tag arrives as inert text content, not as a parsed element.
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> plain/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('ReportView deep-link resolution (fail-closed)', () => {
  const present: Artifact = {
    id: 'art_build_1',
    runId: 'run_x',
    stepId: 'st',
    kind: 'build_log',
    label: 'Build log (iteration 1)',
    mimeType: 'text/plain',
    sizeBytes: 10,
  };

  it('links a resolvable label and leaves an unresolvable one as plain text', () => {
    renderView(
      'See **Build log (iteration 1)** and **Ghost log** for detail.',
      [present],
      'run_x',
    );
    const link = screen.getByRole('link', { name: 'Build log (iteration 1)' });
    expect(link).toHaveAttribute('href', '/runs/run_x/evidence?artifact=art_build_1');

    // The unresolvable reference renders as text, never as a link (no dead href).
    expect(screen.queryByRole('link', { name: 'Ghost log' })).not.toBeInTheDocument();
    expect(screen.getByText('Ghost log')).toBeInTheDocument();
  });
});
