// Evidence Detail drawer (§7.4, T3.1+T3.2): deep-link routing per artifact kind
// at the component level across all five live tabs, plus the fail-closed states
// for malformed log/diff content and the rollback affordance rules. Views come
// from the real reduceRun (D5); artifact content is stubbed at the api seam —
// transport is covered by the integration tests.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { Event, MeasurementCheck, RunView } from '@boardex/contract';
import { reduceRun } from '@boardex/contract';
import { api } from '../../lib/api';
import { artifactOf, envelope, run, runStep, RUN_ID } from '../workspace/test-events';
import { EvidenceDrawer } from './EvidenceDrawer';

const DECODE_JSON = JSON.stringify({
  protocol: 'i2c',
  sample_rate_hz: 4_000_000,
  annotations: [
    { raw: '812000-812010 i2c-1: START', start: 812000, end: 812010, decoder: 'i2c-1', text: 'START' },
    {
      raw: '812010-812370 i2c-1: ADDRESS WRITE: 76 NACK',
      start: 812010,
      end: 812370,
      decoder: 'i2c-1',
      text: 'ADDRESS WRITE: 76 NACK',
    },
    { raw: '812370-812380 i2c-1: STOP', start: 812370, end: 812380, decoder: 'i2c-1', text: 'STOP' },
  ],
  transactions: [{ addr_7bit: 59, rw: 'w', write: [], read: [], nack_at: 'address' }],
});

const SERIAL_LOG = 'BME280: probing at 0x76\nI2C1 ERROR: timeout waiting for TXIS (read setup)\n';

const DIFF_JSON = JSON.stringify({
  files: [
    {
      path: 'main.c',
      reason: 'Shift the 7-bit address into SADD[7:1].',
      diff: '@@ -60,2 +60,3 @@\n #define BME280_ADDR 0x76U\n+#define BME280_SADD ((uint32_t)BME280_ADDR << 1)\n #define BME280_CHIP_ID 0x60U\n',
    },
  ],
});

const CONTENT_BY_ID: Record<string, string> = {
  art_decode: DECODE_JSON,
  art_serial_1: SERIAL_LOG,
  art_serial_2: 'TEMP=24.3 HUM=41.2\n',
  art_diff: DIFF_JSON,
};

const ackCheck: MeasurementCheck = {
  id: 'chk_ack',
  runId: RUN_ID,
  requirementId: 'device_ack',
  description: 'BME280 must ACK its 7-bit address 0x76',
  measurement: 'logic_analyzer.i2c.device_ack',
  expected: { equals: true },
  actual: { value: false },
  verdict: 'fail',
  artifactId: 'art_decode',
};

// One of each T3.2 kind plus a decode, two serial logs across two iterations,
// and a timing measurement — the fixture's evidence surface in miniature.
function baseEvents(): Event[] {
  return [
    envelope(1, 'run.created', { run }),
    envelope(2, 'step.started', { step: runStep('st_serial_1', 3, 'Read serial') }),
    envelope(3, 'artifact.created', {
      artifact: { ...artifactOf('art_serial_1', 'serial_log'), stepId: 'st_serial_1' },
    }),
    envelope(4, 'artifact.created', { artifact: artifactOf('art_decode', 'protocol_decode') }),
    envelope(5, 'artifact.created', { artifact: artifactOf('art_timing', 'timing_measurement') }),
    envelope(6, 'artifact.created', {
      artifact: { ...artifactOf('art_diff', 'code_diff'), label: 'Code diff — address fix' },
    }),
    envelope(7, 'check.evaluated', { check: ackCheck }),
    envelope(8, 'run.iteration_started', { iteration: 2, reason: 'Applying fix' }),
    envelope(9, 'step.started', { step: runStep('st_serial_2', 3, 'Read serial') }),
    envelope(10, 'artifact.created', {
      artifact: { ...artifactOf('art_serial_2', 'serial_log'), stepId: 'st_serial_2' },
    }),
  ];
}

function buildView(extra: Event[] = []): RunView {
  return reduceRun([...baseEvents(), ...extra])!;
}

function renderDrawer(search: string, view: RunView = buildView()) {
  vi.spyOn(api, 'getArtifactText').mockImplementation((id) => {
    const content = CONTENT_BY_ID[id];
    return content !== undefined
      ? Promise.resolve(content)
      : Promise.reject(new Error(`no stub for ${id}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (v: RunView) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}/evidence${search}`]}>
        <EvidenceDrawer view={v} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(ui(view));
  // Feed the drawer an updated RunView, as the live event stream does.
  return { ...result, rerenderView: (v: RunView) => result.rerender(ui(v)) };
}

// jsdom reports zero offset sizes, so the LogViewer's virtualizer would render
// no rows at all — give every element a box (same treatment as LogViewer.test).
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 320,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tab = (name: string) => screen.getByRole('tab', { name });

describe('EvidenceDrawer tabs', () => {
  it('defaults to Checks with every tab enabled', () => {
    renderDrawer('');
    expect(tab('Checks')).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Protocol Decode', 'Logs', 'Code Diff', 'Raw artifacts']) {
      expect(tab(name)).not.toHaveAttribute('aria-disabled');
    }
    expect(screen.getByRole('table', { name: 'Measurement checks' })).toBeInTheDocument();
  });

  it('switches to each content tab by hand, rendering the latest subject of its kind', async () => {
    const user = userEvent.setup();
    renderDrawer('');

    await user.click(tab('Protocol Decode'));
    expect(await screen.findByRole('table', { name: 'Decoded transactions' })).toBeInTheDocument();

    await user.click(tab('Logs'));
    // Opened by hand: the first log artifact drives the two selectors (Sprint 7 P0).
    const iterationGroup = screen.getByRole('group', { name: 'Iteration' });
    expect(within(iterationGroup).getByRole('button', { name: '1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const typeGroup = screen.getByRole('group', { name: 'Type' });
    expect(within(typeGroup).getByRole('button', { name: 'Serial' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(tab('Code Diff'));
    expect(await screen.findByText('main.c')).toBeInTheDocument();

    await user.click(tab('Raw artifacts'));
    expect(screen.getByRole('table', { name: 'Raw artifacts' })).toBeInTheDocument();
  });
});

describe('EvidenceDrawer deep links (?artifact=…)', () => {
  it('a serial_log artifact opens the Logs tab with the selectors on its exact cell', async () => {
    renderDrawer('?artifact=art_serial_2');
    expect(tab('Logs')).toHaveAttribute('aria-selected', 'true');
    expect(
      within(screen.getByRole('group', { name: 'Iteration' })).getByRole('button', { name: '2' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(screen.getByRole('group', { name: 'Type' })).getByRole('button', { name: 'Serial' }),
    ).toHaveAttribute('aria-pressed', 'true');
    const log = await screen.findByRole('log');
    expect(log).toHaveTextContent('TEMP=24.3 HUM=41.2');
  });

  it('the other iteration’s serial log stays reachable via the Iteration selector', async () => {
    const user = userEvent.setup();
    renderDrawer('?artifact=art_serial_2');
    await user.click(
      within(screen.getByRole('group', { name: 'Iteration' })).getByRole('button', { name: '1' }),
    );
    expect(await screen.findByRole('log')).toHaveTextContent('BME280: probing at 0x76');
  });

  it('a code_diff artifact opens the Code Diff tab with the per-file diff and reason', async () => {
    renderDrawer('?artifact=art_diff');
    expect(tab('Code Diff')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('main.c')).toBeInTheDocument();
    expect(screen.getByText('Shift the 7-bit address into SADD[7:1].')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Unified diff for main.c' });
    const added = table.querySelectorAll('tr[data-diff="add"]');
    expect(added).toHaveLength(1);
    expect(added[0]).toHaveTextContent('#define BME280_SADD');
    // P1 #7 line tints (D14-compliant): an addition wears the pass tint; a
    // context line stays untinted (the changed-ness is the semantic).
    expect(added[0]).toHaveClass('bg-pass-bg');
    const context = table.querySelector('tr[data-diff="context"]');
    expect(context).not.toBeNull();
    expect(context).not.toHaveClass('bg-pass-bg');
    expect(context).not.toHaveClass('bg-fail-bg');
    // P1 #7 no-wrap: the code cell never wraps and the box scrolls horizontally.
    expect(table.querySelector('td.whitespace-pre')).not.toBeNull();
    expect(table.closest('div.overflow-x-auto')).not.toBeNull();
  });

  it('a timing_measurement artifact opens Raw artifacts with its row highlighted', () => {
    renderDrawer('?artifact=art_timing');
    expect(tab('Raw artifacts')).toHaveAttribute('aria-selected', 'true');
    const table = screen.getByRole('table', { name: 'Raw artifacts' });
    const highlighted = table.querySelectorAll('tbody tr[data-highlighted]');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toHaveTextContent('timing_measurement');
  });

  it('an unknown artifact id fails closed on Checks with an explicit notice', () => {
    renderDrawer('?artifact=art_ghost');
    expect(tab('Checks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(
      `Artifact "art_ghost" isn't part of this run's evidence.`,
    );
  });

  it('routes to the artifact’s tab when a deep-linked artifact arrives after mount', async () => {
    // The link references iteration 2's diff before its artifact.created has
    // streamed in: fail closed on Checks with the notice…
    const before = buildView();
    const { rerenderView } = renderDrawer('?artifact=art_diff_2', before);
    expect(tab('Checks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(
      `Artifact "art_diff_2" isn't part of this run's evidence.`,
    );

    // …then the artifact.created lands and the same link resolves to its tab.
    CONTENT_BY_ID['art_diff_2'] = DIFF_JSON;
    try {
      rerenderView(
        buildView([
          envelope(11, 'artifact.created', {
            artifact: { ...artifactOf('art_diff_2', 'code_diff'), label: 'Code diff — retry' },
          }),
        ]),
      );
      expect(tab('Code Diff')).toHaveAttribute('aria-selected', 'true');
      expect(
        screen.queryByText(/isn't part of this run's evidence/),
      ).not.toBeInTheDocument();
      expect(await screen.findByText('main.c')).toBeInTheDocument();
    } finally {
      delete CONTENT_BY_ID['art_diff_2'];
    }
  });
});

describe('EvidenceDrawer fail-closed content states', () => {
  it('renders an error state for unparseable decode content, not a crash', async () => {
    CONTENT_BY_ID['art_decode'] = 'not json at all';
    try {
      renderDrawer('?artifact=art_decode');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Decode artifact unreadable');
      expect(alert).toHaveTextContent('not valid JSON');
      expect(screen.queryByRole('table', { name: 'Decoded transactions' })).not.toBeInTheDocument();
    } finally {
      CONTENT_BY_ID['art_decode'] = DECODE_JSON;
    }
  });

  it('renders a retryable error state when the decode artifact fetch fails', async () => {
    delete CONTENT_BY_ID['art_decode'];
    try {
      renderDrawer('?artifact=art_decode');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Couldn’t load the decode artifact');
      expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    } finally {
      CONTENT_BY_ID['art_decode'] = DECODE_JSON;
    }
  });

  it('renders an error state for a malformed code_diff artifact, not a crash', async () => {
    CONTENT_BY_ID['art_diff'] = '{"files": "nope"}';
    try {
      renderDrawer('?artifact=art_diff');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Diff artifact unreadable');
      expect(alert).toHaveTextContent('code-diff shape');
    } finally {
      CONTENT_BY_ID['art_diff'] = DIFF_JSON;
    }
  });

  it('renders a per-file error when a file’s unified diff text is unreadable', async () => {
    CONTENT_BY_ID['art_diff'] = JSON.stringify({
      files: [{ path: 'main.c', reason: 'r', diff: 'not a diff' }],
    });
    try {
      renderDrawer('?artifact=art_diff');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Diff unreadable');
      expect(alert).toHaveTextContent('No unified-diff hunks');
    } finally {
      CONTENT_BY_ID['art_diff'] = DIFF_JSON;
    }
  });

  it('renders an error state for non-text log content, not mojibake', async () => {
    CONTENT_BY_ID['art_serial_2'] = 'ELF\u0000binary';
    try {
      renderDrawer('?artifact=art_serial_2');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Log artifact unreadable');
      expect(alert).toHaveTextContent('not renderable text');
    } finally {
      CONTENT_BY_ID['art_serial_2'] = 'TEMP=24.3 HUM=41.2\n';
    }
  });
});

describe('EvidenceDrawer rollback affordance (§7.4)', () => {
  it('is enabled while the run is non-terminal and surfaces the MVP notice on click', async () => {
    const user = userEvent.setup();
    renderDrawer('?artifact=art_diff');
    const rollback = await screen.findByRole('button', { name: 'Rollback' });
    expect(rollback).toBeEnabled();

    // MVP surfaces the affordance only: the click fires zero network requests —
    // nothing through fetch, nothing through the api layer.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const apiCallsBefore = vi.mocked(api.getArtifactText).mock.calls.length;
    await user.click(rollback);
    expect(screen.getByRole('status')).toHaveTextContent(/performed by the runner/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(api.getArtifactText).mock.calls.length).toBe(apiCallsBefore);
  });

  it('is disabled with an explanatory tooltip once the run is terminal', async () => {
    const terminalView = buildView([
      envelope(11, 'run.status_changed', { status: 'completed' }),
    ]);
    renderDrawer('?artifact=art_diff', terminalView);
    const rollback = await screen.findByRole('button', { name: 'Rollback' });
    expect(rollback).toBeDisabled();
    expect(rollback).toHaveAttribute(
      'title',
      expect.stringMatching(/completed.*only available while a run is active/),
    );
  });
});

// T6.3: the Sources tab is part of the drawer, and a ?doc=…&loc=… deep link opens
// it at that document with the locator highlighted. documents come from the run's
// board profile (RunPage passes profile.documents).
describe('EvidenceDrawer Sources tab (T6.3)', () => {
  const datasheet = {
    id: 'doc_bme280_datasheet',
    label: 'BME280 datasheet (excerpt)',
    kind: 'datasheet' as const,
    mimeType: 'text/markdown',
  };
  // Two headings so a second citation can target a DIFFERENT locator in the SAME
  // document (the review F1 probe).
  const DOC_MD =
    '# BME280\n\n## I2C device addressing\n\nSDO to GND selects 0x76.\n\n## Timing specifications\n\nStandard mode 100 kHz.\n';

  function renderWithDocs(search: string, view: RunView = buildView()) {
    vi.spyOn(api, 'getDocumentText').mockResolvedValue(DOC_MD);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN_ID}/evidence${search}`]}>
          <EvidenceDrawer view={view} documents={[datasheet]} onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('renders a Sources tab that lists the profile documents', async () => {
    const user = userEvent.setup();
    renderWithDocs('');
    await user.click(screen.getByRole('tab', { name: 'Sources' }));
    expect(await screen.findByRole('heading', { name: 'Timing specifications' })).toBeInTheDocument();
  });

  it('a ?doc deep link opens the Sources tab at the located section', async () => {
    renderWithDocs('?doc=doc_bme280_datasheet&loc=timing-specifications');
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    const located = await screen.findByRole('heading', { name: 'Timing specifications' });
    expect(located).toHaveAttribute('data-located', 'true');
  });

  // Review F1 probe: navigate ?doc=X&loc=A, switch to Checks, navigate ?doc=X&loc=B
  // (same document, different locator) — Sources must re-select and re-highlight.
  it('re-selects Sources and re-highlights on a second citation to the same doc, different locator', async () => {
    vi.spyOn(api, 'getDocumentText').mockResolvedValue(DOC_MD);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate(`/runs/${RUN_ID}/evidence?doc=doc_bme280_datasheet&loc=timing-specifications`)}>
            cite-timing
          </button>
          <EvidenceDrawer view={buildView()} documents={[datasheet]} onClose={() => {}} />
        </>
      );
    }
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[`/runs/${RUN_ID}/evidence?doc=doc_bme280_datasheet&loc=i2c-device-addressing`]}
        >
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'I2C device addressing' })).toHaveAttribute(
      'data-located',
      'true',
    );

    // The user browses away to Checks.
    await user.click(screen.getByRole('tab', { name: 'Checks' }));
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'false');

    // A second citation arrives: same document, a different locator.
    await user.click(screen.getByRole('button', { name: 'cite-timing' }));
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Timing specifications' })).toHaveAttribute(
      'data-located',
      'true',
    );
    // The prior locator is no longer highlighted.
    expect(screen.getByRole('heading', { name: 'I2C device addressing' })).not.toHaveAttribute(
      'data-located',
    );
  });

  // Fixture-shaped: two checks cite the SAME document at different locators; clicking
  // each check's Source link in turn lands the Sources tab highlighted at each.
  it('lands both of two same-document citations highlighted, via the Checks source links', async () => {
    const clockCheck: MeasurementCheck = {
      id: 'chk_clock',
      runId: RUN_ID,
      requirementId: 'i2c_clock',
      description: 'clock',
      measurement: 'm',
      expected: { min: 90000, max: 110000 },
      actual: { value: 99600, unit: 'Hz' },
      verdict: 'pass',
      artifactId: 'art_timing',
      sourceRef: 'BME280 datasheet §6.2',
      sourceDoc: { documentId: 'doc_bme280_datasheet', locator: 'timing-specifications' },
    };
    const ackCited: MeasurementCheck = {
      ...ackCheck,
      sourceRef: 'BME280 datasheet §5.4.1',
      sourceDoc: { documentId: 'doc_bme280_datasheet', locator: 'i2c-device-addressing' },
    };
    const view = buildView([
      envelope(11, 'check.evaluated', { check: clockCheck }),
      envelope(12, 'check.evaluated', { check: ackCited }),
    ]);
    const user = userEvent.setup();
    renderWithDocs('', view);

    // Citation 1: i2c_clock → timing spec.
    await user.click(screen.getByRole('link', { name: 'BME280 datasheet §6.2' }));
    expect(
      await screen.findByRole('heading', { name: 'Timing specifications' }),
    ).toHaveAttribute('data-located', 'true');

    // Back to Checks, then citation 2: device_ack → addressing, same document.
    await user.click(screen.getByRole('tab', { name: 'Checks' }));
    await user.click(screen.getByRole('link', { name: 'BME280 datasheet §5.4.1' }));
    expect(
      await screen.findByRole('heading', { name: 'I2C device addressing' }),
    ).toHaveAttribute('data-located', 'true');
  });
});
