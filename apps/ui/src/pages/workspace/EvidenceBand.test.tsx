// Evidence Summary band (BIBLE §7.3): one chip per check (verdict badge + short
// name), each deep-linking that check's artifact; Open Logs/Diff/Report deep-linking
// real artifacts; a quiet neutral line before any check is evaluated. Views are the
// real reduceRun output (D5).
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

describe('EvidenceBand verdict-flip (T6.2)', () => {
  // The badge wrapper is the parent of the verdict badge span.
  const flipWrapper = () =>
    screen
      .getByRole('list', { name: 'Evidence checks' })
      .querySelector('[data-kind="verdict"]')!.parentElement!;

  const ackView = (verdict: 'pass' | 'fail') =>
    buildView([
      { type: 'artifact.created', payload: { artifact: artifactOf('art_ack', 'protocol_decode') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_ack', 'device_ack', 'art_ack', verdict) } },
    ]);

  it('plays the emphasis only when a check re-evaluates FAIL → PASS', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <EvidenceBand view={ackView('fail')} />
      </MemoryRouter>,
    );
    // Initial fail render: no emphasis.
    expect(flipWrapper().className).not.toContain('animate-verdict-flip');

    rerender(
      <MemoryRouter>
        <EvidenceBand view={ackView('pass')} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(flipWrapper().className).toContain('animate-verdict-flip'));
  });

  it('does not flip a check that is PASS from the first render (reloaded run)', () => {
    render(
      <MemoryRouter>
        <EvidenceBand view={ackView('pass')} />
      </MemoryRouter>,
    );
    expect(flipWrapper().className).not.toContain('animate-verdict-flip');
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
  it('deep-links Open Logs / Open Diff to real artifact ids, Open Report to the §7.6 report screen', () => {
    const view = buildView([
      { type: 'artifact.created', payload: { artifact: artifactOf('art_diff', 'code_diff') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_serial', 'serial_log') } },
      { type: 'artifact.created', payload: { artifact: artifactOf('art_report', 'report_md') } },
      { type: 'check.evaluated', payload: { check: checkOf('chk_serial', 'serial_output', 'art_serial', 'pass') } },
    ]);
    renderBand(view);

    expect(screen.getByRole('link', { name: 'Open Logs' }).getAttribute('href')).toBe(href('art_serial'));
    expect(screen.getByRole('link', { name: 'Open Diff' }).getAttribute('href')).toBe(href('art_diff'));
    // Open Report leaves the evidence drawer for the dedicated Validation Report view.
    expect(screen.getByRole('link', { name: 'Open Report' }).getAttribute('href')).toBe(
      '/runs/run_t21/report',
    );
  });

  // The report gate must key on report_md SPECIFICALLY — the fail-variant run ends
  // with diffs and logs but no report, and its Open Report must be inert (§7.6:
  // never a live link into the "No report" dead end). These two views are chosen so
  // a gate reading any other artifact kind (targets.diff, targets.logs) fails one
  // of them — the T5.1 review showed the all-kinds view above cannot tell them apart.
  it('keeps Open Report inert when diffs and logs exist but no report_md does (fail-variant shape)', () => {
    renderBand(
      buildView([
        { type: 'artifact.created', payload: { artifact: artifactOf('art_diff', 'code_diff') } },
        { type: 'artifact.created', payload: { artifact: artifactOf('art_serial', 'serial_log') } },
      ]),
    );
    expect(screen.getByRole('link', { name: 'Open Logs' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Diff' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Report' })).not.toBeInTheDocument();
    expect(screen.getByText('Open Report')).toHaveAttribute('aria-disabled', 'true');
  });

  it('enables Open Report from a report_md artifact alone', () => {
    renderBand(
      buildView([
        { type: 'artifact.created', payload: { artifact: artifactOf('art_report', 'report_md') } },
      ]),
    );
    expect(screen.getByRole('link', { name: 'Open Report' }).getAttribute('href')).toBe(
      `/runs/${RUN_ID}/report`,
    );
    expect(screen.getByText('Open Logs')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Open Diff')).toHaveAttribute('aria-disabled', 'true');
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

// v2.4 (Sprint 7 P0 stage 4): registered-but-never-recorded expectations render
// one neutral chip each — gray with the dash icon, NEVER red, linking nowhere.
describe('EvidenceBand not-recorded chips (v2.4)', () => {
  const partialView = (): RunView =>
    viewFrom([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.plan_generated', {
        plan: [],
        riskSummary: 'risk',
        checks: [
          { requirementId: 'build_exit_code', description: 'Build exits 0' },
          { requirementId: 'device_ack', description: 'ACK at 0x76' },
          { requirementId: 'i2c_clock', description: 'SCL 100 kHz ±10%' },
          { requirementId: 'serial_output', description: 'TEMP/HUM on serial' },
        ],
      }),
      envelope(3, 'artifact.created', { artifact: artifactOf('art_build', 'build_log') }),
      envelope(4, 'check.evaluated', {
        check: checkOf('chk_build', 'build_exit_code', 'art_build', 'pass'),
      }),
      envelope(5, 'run.failed', { summary: 'turn bound exceeded' }),
    ]);

  const renderBand = (view: RunView) =>
    render(
      <MemoryRouter>
        <EvidenceBand view={view} />
      </MemoryRouter>,
    );

  it('renders one neutral not-recorded chip per unrecorded registered check', () => {
    renderBand(partialView());
    const chips = screen.getAllByText('Not recorded');
    expect(chips).toHaveLength(3);
    for (const badge of chips) {
      expect(badge).toHaveClass('bg-neutral-badge-bg', 'text-neutral-badge');
      expect(badge.classList.contains('text-fail')).toBe(false);
      expect(badge.querySelector('[data-verdict-icon="not_recorded"]')).not.toBeNull();
    }
    expect(screen.getByText('I2C clock')).toBeInTheDocument();
    expect(screen.getByText('Serial output')).toBeInTheDocument();
  });

  it('not-recorded chips link nowhere — there is no artifact to open', () => {
    renderBand(partialView());
    const chip = screen.getByText('I2C clock').closest('li') as HTMLElement;
    expect(within(chip).queryByRole('link')).toBeNull();
  });

  it('a run without a registry renders NO not-recorded chips — nothing is invented', () => {
    const view = viewFrom([
      envelope(1, 'run.created', { run }),
      envelope(2, 'artifact.created', { artifact: artifactOf('art_build', 'build_log') }),
      envelope(3, 'check.evaluated', {
        check: checkOf('chk_build', 'build_exit_code', 'art_build', 'pass'),
      }),
      envelope(4, 'run.failed', { summary: 'turn bound exceeded' }),
    ]);
    renderBand(view);
    expect(screen.queryByText('Not recorded')).not.toBeInTheDocument();
  });

  it('while the run is live, registered checks render no chips yet — coverage is a terminal statement', () => {
    const view = viewFrom([
      envelope(1, 'run.created', { run }),
      envelope(2, 'run.plan_generated', {
        plan: [],
        riskSummary: 'risk',
        checks: [{ requirementId: 'i2c_clock', description: 'SCL 100 kHz ±10%' }],
      }),
    ]);
    renderBand(view);
    expect(screen.queryByText('Not recorded')).not.toBeInTheDocument();
    expect(screen.getByText('No checks evaluated yet.')).toBeInTheDocument();
  });
});
