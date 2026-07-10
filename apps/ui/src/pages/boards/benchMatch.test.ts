// Validate-against-bench derivation (BIBLE §7.5): found / degraded / missing, from a
// profile's instrument references and a live BenchStatus.
import { describe, expect, it } from 'vitest';
import { BenchStatusSchema, type BenchStatus } from '@boardex/contract';
import { hasBenchWarnings, matchInstruments } from './benchMatch';

const PROBE_ID = 'pyocd:stlink:066EFF383733554157254923';
const LA_ID = 'sigrok:kingst-la2016:conn=3.12';

function bench(over: { laState?: 'online' | 'offline' | 'error' } = {}): BenchStatus {
  return BenchStatusSchema.parse({
    runnerOnline: true,
    contractVersion: 'boardex-contract/0.1',
    devices: [
      { id: PROBE_ID, kind: 'debug_probe', name: 'ST-Link/V2-1 (NUCLEO-F303RE)', state: 'online' },
      { id: 'serial:/dev/ttyACM0', kind: 'serial', name: 'USART2 over ST-Link VCP', state: 'online' },
      { id: LA_ID, kind: 'logic_analyzer', name: 'Kingst LA2016', state: over.laState ?? 'online' },
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
