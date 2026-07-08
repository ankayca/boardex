// Evidence Summary band (BIBLE §7.3): one chip per check (verdict badge + short
// name), each deep-linking that check's artifact; Open Logs/Diff/Report deep-linking
// real artifacts; a quiet neutral line before any check is evaluated. Views are the
// real reduceRun output (D5).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Event, RunView } from '@boardex/contract';
import { EvidenceBand } from './EvidenceBand';
import { artifactOf, checkOf, envelope, run, RUN_ID, viewFrom } from './test-events';

function buildView(events: { type: Event['type']; payload: unknown }[]): RunView {
  const stream: Event[] = [
    envelope(1, 'run.created', { run }),
    ...events.map((e, i) => envelope(i + 2, e.type as never, e.payload as never)),
  ];
  return viewFrom(stream);
}

function renderBand(view: RunView) {
  render(
    <MemoryRouter>
      <EvidenceBand view={view} />
    </MemoryRouter>,
  );
}

const href = (artifactId: string) => `/runs/${RUN_ID}/evidence?artifact=${artifactId}`;

describe('EvidenceBand chips', () => {
  it('renders one chip per check: resolvable checks deep-link their artifact, an evidence-law downgrade renders inert', () => {
    const view = buildView([
      { type: 'artifact.created', payload: { artifact: artifactOf('art_clock', 'timing_measurement') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_ack', 'protocol_decode') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_clock', 'i2c_clock', 'art_clock', 'pass') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_ack', 'device_ack', 'art_ack', 'fail') } },
      // Missing artifact → evidence-law downgrade to needs_review; the chip must
      // NOT link a nonexistent artifact (T2.3 review finding 2).
      { type: 'check.evaluated', payload: { check: checkOf('chk_serial', 'serial_output', 'art_serial_x', 'fail') } },
    ]);
    renderBand(view);

    const chips = within(screen.getByRole('list', { name: 'Evidence checks' })).getAllByRole('listitem');
    expect(chips).toHaveLength(3);

    // Positive case: resolvable checks are links carrying their own artifactId.
    const clockLink = within(chips[0]!).getByRole('link');
    expect(clockLink).toHaveTextContent('I2C clock');
    expect(clockLink.getAttribute('href')).toBe(href('art_clock'));
    const ackLink = within(chips[1]!).getByRole('link');
    expect(ackLink).toHaveTextContent('Device ack');
    expect(ackLink.getAttribute('href')).toBe(href('art_ack'));

    // Downgraded case: verdict badge and name render, but inert — no link, no href.
    expect(within(chips[2]!).queryByRole('link')).not.toBeInTheDocument();
    const inert = chips[2]!.querySelector('[aria-disabled="true"]');
    expect(inert).not.toBeNull();
    expect(inert).toHaveTextContent('Serial output');

    // Verdict badges, in order, by their reserved data-value.
    expect(chips[0]!.querySelector('[data-kind="verdict"][data-value="pass"]')).not.toBeNull();
    expect(chips[1]!.querySelector('[data-kind="verdict"][data-value="fail"]')).not.toBeNull();
    expect(chips[2]!.querySelector('[data-kind="verdict"][data-value="needs_review"]')).not.toBeNull();
  });
});

describe('EvidenceBand geometry (§6.3)', () => {
  it('holds the 88px collapsed strip: fixed height, chips overflow horizontally instead of wrapping taller', () => {
    // Enough chips that a wrapping layout would need multiple rows.
    const artifacts = Array.from({ length: 12 }, (_, i) => ({
      type: 'artifact.created' as const,
      payload: { artifact: artifactOf(`art_${i}`, 'timing_measurement') },
    }));
    const checks = Array.from({ length: 12 }, (_, i) => ({
      type: 'check.evaluated' as const,
      payload: { check: checkOf(`chk_${i}`, `requirement_${i}_long_name`, `art_${i}`, 'pass') },
    }));
    renderBand(buildView([...artifacts, ...checks]));

    // jsdom does no layout, so the geometry contract is pinned via the classes that
    // enforce it: a fixed h-[88px] band that never wraps, and a chip list that
    // scrolls in its own overflow-x container.
    const band = screen.getByRole('region', { name: 'Evidence summary' });
    expect(band.className).toContain('h-[88px]');
    expect(band.className).not.toContain('flex-wrap');
    const list = screen.getByRole('list', { name: 'Evidence checks' });
    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).not.toContain('flex-wrap');
  });
});

describe('EvidenceBand actions', () => {
  it('deep-links Open Logs / Open Diff / Open Report to real artifact ids from RunView', () => {
    const view = buildView([
      { type: 'artifact.created', payload: { artifact: artifactOf('art_diff', 'code_diff') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_serial', 'serial_log') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_report', 'report_md') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_serial', 'serial_output', 'art_serial', 'pass') } },
    ]);
    renderBand(view);

    expect(screen.getByRole('link', { name: 'Open Logs' }).getAttribute('href')).toBe(href('art_serial'));
    expect(screen.getByRole('link', { name: 'Open Diff' }).getAttribute('href')).toBe(href('art_diff'));
    expect(screen.getByRole('link', { name: 'Open Report' }).getAttribute('href')).toBe(href('art_report'));
  });
});

describe('EvidenceBand empty state', () => {
  it('shows a quiet neutral line — not an empty box — and inert actions before any check', () => {
    renderBand(buildView([]));

    expect(screen.getByText('No checks evaluated yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Evidence checks' })).not.toBeInTheDocument();
    // No artifacts yet → the actions are inert (aria-disabled spans), never dead links.
    for (const label of ['Open Logs', 'Open Diff', 'Open Report']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
      expect(screen.getByText(label)).toHaveAttribute('aria-disabled', 'true');
    }
  });
});
