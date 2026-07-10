// Bench matching, one derivation (BIBLE §7.2/§7.5): found / degraded / missing from a
// profile's instrument references and a live BenchStatus — plus the state-specific
// copy every surface renders, the composer/gate issue list, and Home's indicator.
import { describe, expect, it } from 'vitest';
import { BenchStatusSchema, type BenchStatus } from '@boardex/contract';
import {
  benchAttentionCount,
  benchAttentionLabel,
  benchIssues,
  benchIssuesTitle,
  benchMatchText,
  hasBenchWarnings,
  matchInstruments,
} from './benchReadiness';

const PROBE_ID = 'pyocd:stlink:066EFF383733554157254923';
const LA_ID = 'sigrok:kingst-la2016:conn=3.12';

function bench(over: { laState?: 'online' | 'offline' | 'error' } = {}): BenchStatus {
  return BenchStatusSchema.parse({
    runnerOnline: true,
    contractVersion: 'boardex-contract/0.1',
    devices: [
      { id: PROBE_ID, kind: 'debug_probe', name: 'ST-Link/V2-1 (NUCLEO-F303RE)', state: 'online' },
      { id: 'serial:/dev/ttyACM0', kind: 'serial', name: 'USART2 over ST-Link VCP', state: 'online' },
      {
        id: LA_ID,
        kind: 'logic_analyzer',
        name: 'Kingst LA2016',
        state: over.laState ?? 'online',
        ...(over.laState && over.laState !== 'online' ? { detail: 'Not detected by sigrok' } : {}),
      },
    ],
  });
}

describe('matchInstruments', () => {
  it('resolves a device id (what the picker writes) to a found device', () => {
    const [probe] = matchInstruments({ debugProbe: PROBE_ID }, bench());
    expect(probe).toEqual({
      kind: 'debug_probe',
      label: 'Debug probe',
      reference: PROBE_ID,
      status: 'found',
      deviceId: PROBE_ID,
      deviceName: 'ST-Link/V2-1 (NUCLEO-F303RE)',
      deviceState: 'online',
    });
  });

  it('resolves an exact device name, case- and whitespace-insensitively', () => {
    const [probe] = matchInstruments({ debugProbe: '  st-link/v2-1 (NUCLEO-F303RE) ' }, bench());
    expect(probe?.status).toBe('found');
    expect(probe?.deviceId).toBe(PROBE_ID);
  });

  it('marks a reference no device answers to as missing, keeping the name that failed', () => {
    const [probe] = matchInstruments({ debugProbe: 'J-Link EDU' }, bench());
    expect(probe).toMatchObject({ status: 'missing', reference: 'J-Link EDU' });
    expect(probe).not.toHaveProperty('deviceId');
  });

  it.each([
    ['offline', 'degraded'],
    ['error', 'degraded'],
    ['online', 'found'],
  ] as const)('a matched device that is %s is %s', (laState, status) => {
    const matches = matchInstruments(
      { debugProbe: PROBE_ID, logicAnalyzer: LA_ID },
      bench({ laState }),
    );
    expect(matches[1]).toMatchObject({ status, deviceId: LA_ID, deviceState: laState });
  });

  it('never matches across device kinds', () => {
    // The serial device's id, claimed as a debug probe: still missing.
    const [probe] = matchInstruments({ debugProbe: 'serial:/dev/ttyACM0' }, bench());
    expect(probe?.status).toBe('missing');
  });

  it('an unset logic analyzer is not a missing device — it is simply not claimed', () => {
    expect(matchInstruments({ debugProbe: PROBE_ID }, bench())).toHaveLength(1);
    expect(matchInstruments({ debugProbe: PROBE_ID, logicAnalyzer: '  ' }, bench())).toHaveLength(1);
  });

  // Free-text prose describing a device is neither its id nor its name, so it stays
  // missing. This is why the mock runner's canned profile now stores device ids (F2) —
  // and why the hand-typed path still needs covering.
  it('prose that describes a device but is neither its id nor its name does not resolve', () => {
    const matches = matchInstruments(
      { debugProbe: 'ST-Link/V2-1 (on-board, via pyOCD)', logicAnalyzer: 'Kingst LA2016 (sigrok)' },
      bench(),
    );
    expect(matches.map((match) => match.status)).toEqual(['missing', 'missing']);
  });

  // F2: the canned profile's stored references resolve against a healthy bench.
  it('the mock runner’s canned profile validates found/found on a healthy bench', () => {
    const matches = matchInstruments({ debugProbe: PROBE_ID, logicAnalyzer: LA_ID }, bench());
    expect(matches.map((match) => match.status)).toEqual(['found', 'found']);
    expect(hasBenchWarnings(matches)).toBe(false);
  });
});

describe('hasBenchWarnings', () => {
  it('is false only when every referenced instrument is found and online', () => {
    const online = matchInstruments({ debugProbe: PROBE_ID, logicAnalyzer: LA_ID }, bench());
    expect(hasBenchWarnings(online)).toBe(false);

    const degraded = matchInstruments(
      { debugProbe: PROBE_ID, logicAnalyzer: LA_ID },
      bench({ laState: 'offline' }),
    );
    expect(hasBenchWarnings(degraded)).toBe(true);
    expect(hasBenchWarnings(matchInstruments({ debugProbe: 'nope' }, bench()))).toBe(true);
  });
});

// The distinction the whole task exists for: "unplugged" must not read like
// "misspelled". Three states, three sentences.
describe('benchMatchText (three-state copy)', () => {
  const instruments = { debugProbe: PROBE_ID, logicAnalyzer: LA_ID };

  it('says nothing for a found device — the green dot and its id are the message', () => {
    const [probe] = matchInstruments(instruments, bench());
    expect(benchMatchText(probe!)).toBeNull();
  });

  it('an offline match is on the bench but offline, naming the device and the runner detail', () => {
    const [, la] = matchInstruments(instruments, bench({ laState: 'offline' }));
    expect(benchMatchText(la!)).toBe(
      'Kingst LA2016 is on the bench but offline (Not detected by sigrok)',
    );
  });

  it('an errored match is on the bench but in error', () => {
    const [, la] = matchInstruments(instruments, bench({ laState: 'error' }));
    expect(benchMatchText(la!)).toBe(
      'Kingst LA2016 is on the bench but in error (Not detected by sigrok)',
    );
  });

  it('a missing reference was not found on the bench — a different sentence entirely', () => {
    const [probe] = matchInstruments({ debugProbe: 'J-Link EDU' }, bench());
    expect(benchMatchText(probe!)).toBe('J-Link EDU was not found on the bench');
  });

  it('the degraded and missing sentences never collide', () => {
    const [, offline] = matchInstruments(instruments, bench({ laState: 'offline' }));
    const [missing] = matchInstruments({ debugProbe: 'J-Link EDU' }, bench());
    expect(benchMatchText(offline!)).not.toBe(benchMatchText(missing!));
  });
});

describe('benchIssues', () => {
  const instruments = { debugProbe: PROBE_ID, logicAnalyzer: LA_ID };

  it('is empty on a healthy bench whose instruments all resolve', () => {
    expect(benchIssues(bench(), instruments)).toEqual([]);
  });

  it('knows nothing without a bench snapshot', () => {
    expect(benchIssues(null, instruments)).toEqual([]);
  });

  it('lists an unhealthy device with its state, for a StatusDot and the degraded copy', () => {
    expect(benchIssues(bench({ laState: 'error' }), instruments)).toEqual([
      {
        key: LA_ID,
        status: 'degraded',
        message: 'Kingst LA2016 is on the bench but in error (Not detected by sigrok)',
        deviceState: 'error',
      },
    ]);
  });

  // §7.2 says "listing offline devices" — the bench's own report, not a filter of what
  // this profile happens to claim.
  it('lists a degraded device the profile does not reference', () => {
    const issues = benchIssues(bench({ laState: 'offline' }), { debugProbe: PROBE_ID });
    expect(issues.map((issue) => issue.key)).toEqual([LA_ID]);
  });

  it('lists an unmatched profile reference with no device state — nothing to have one', () => {
    const issues = benchIssues(bench(), { debugProbe: 'J-Link EDU' });
    expect(issues).toEqual([
      {
        key: 'missing:debug_probe',
        status: 'missing',
        message: 'J-Link EDU was not found on the bench',
      },
    ]);
    expect(issues[0]).not.toHaveProperty('deviceState');
  });

  it('reports a degraded device once even when the profile also references it', () => {
    const issues = benchIssues(bench({ laState: 'offline' }), instruments);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.status).toBe('degraded');
  });

  it('with no profile selected there is no claim to be missing — only bench facts', () => {
    expect(benchIssues(bench(), null)).toEqual([]);
    expect(benchIssues(bench({ laState: 'offline' }), null)).toHaveLength(1);
  });

  it('reports degraded devices before unmatched references — bench facts first', () => {
    const issues = benchIssues(bench({ laState: 'offline' }), { debugProbe: 'J-Link EDU' });
    expect(issues.map((issue) => issue.status)).toEqual(['degraded', 'missing']);
  });
});

describe('benchIssuesTitle', () => {
  it('is "Bench degraded" only when a real device is unhealthy', () => {
    const degraded = benchIssues(bench({ laState: 'offline' }), { debugProbe: PROBE_ID });
    expect(benchIssuesTitle(degraded)).toBe('Bench degraded');
  });

  it('names the profile, not the bench, when every issue is an unmatched reference', () => {
    const missing = benchIssues(bench(), { debugProbe: 'J-Link EDU' });
    expect(benchIssuesTitle(missing)).toBe('Bench references not found');
  });
});

describe('benchAttentionCount / benchAttentionLabel (§7.1 indicator)', () => {
  it('counts devices the runner reports as anything but online', () => {
    expect(benchAttentionCount(bench())).toBe(0);
    expect(benchAttentionCount(bench({ laState: 'offline' }))).toBe(1);
    expect(benchAttentionCount(bench({ laState: 'error' }))).toBe(1);
    expect(benchAttentionCount(null)).toBe(0);
  });

  it('pluralizes', () => {
    expect(benchAttentionLabel(1)).toBe('1 instrument needs attention');
    expect(benchAttentionLabel(2)).toBe('2 instruments need attention');
  });
});
