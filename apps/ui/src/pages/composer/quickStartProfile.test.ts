// Quick Start's profile compiler (v0). The whole promise of the flow is that the
// profile a given (path + bench + detected build) produces is knowable and reviewable,
// so these assert the WHOLE object, not a field at a time.
import { describe, expect, it } from 'vitest';
import { BoardProfileSchema, type BenchStatus } from '@boardex/contract';
import {
  buildQuickStartProfile,
  quickStartName,
  QUICK_START_CHECKLIST,
  QUICK_START_POWER_NOTE,
} from './quickStartProfile';

const BENCH: BenchStatus = {
  runnerOnline: true,
  contractVersion: 'boardex-contract/0.1',
  devices: [
    {
      id: 'pyocd:stlink:066EFF383733554157254923',
      kind: 'debug_probe',
      name: 'ST-Link/V2-1 (NUCLEO-F303RE)',
      state: 'online',
      detail: 'stm32f303retx',
    },
    {
      id: 'serial:/dev/ttyACM0',
      kind: 'serial',
      name: 'USART2 over ST-Link VCP',
      state: 'online',
      detail: '115200 8N1',
    },
    {
      id: 'sigrok:kingst-la2016:conn=3.12',
      kind: 'logic_analyzer',
      name: 'Kingst LA2016',
      state: 'online',
    },
  ],
};

const EMPTY_BENCH: BenchStatus = {
  runnerOnline: true,
  contractVersion: 'boardex-contract/0.1',
  devices: [],
};

describe('quickStartName', () => {
  it('derives the board name from the repo folder, trailing slash or not', () => {
    expect(quickStartName('/bench/firmware/bme280-f303re')).toBe('bme280-f303re');
    expect(quickStartName('/bench/firmware/bme280-f303re/')).toBe('bme280-f303re');
    expect(quickStartName('  ~/fw/blinky  ')).toBe('blinky');
  });

  it('falls back rather than producing a nameless board', () => {
    expect(quickStartName('')).toBe('New board');
  });
});

describe('buildQuickStartProfile — the exact profile a bench + path + detection produces', () => {
  it('compiles the full profile from a healthy bench and a detected build', () => {
    const profile = buildQuickStartProfile(
      {
        repoPath: '/bench/firmware/bme280-f303re/',
        name: 'bme280-f303re',
        detectedBuild: 'make',
        bench: BENCH,
      },
      'bp_quickstart_test',
    );

    expect(profile).toEqual({
      id: 'bp_quickstart_test',
      name: 'bme280-f303re',
      // What the BENCH reports the probe is attached to — not a datasheet part name.
      mcu: 'stm32f303retx',
      repoPath: '/bench/firmware/bme280-f303re',
      buildCommand: 'make',
      flashCommand: 'pyocd flash --target stm32f303retx firmware.elf',
      resetCommand: 'pyocd reset --target stm32f303retx',
      serial: { port: '/dev/ttyACM0', baud: 115200 },
      // The bench devices' stable registry ids (§4) — what the builder's picker writes.
      instruments: {
        debugProbe: 'pyocd:stlink:066EFF383733554157254923',
        logicAnalyzer: 'sigrok:kingst-la2016:conn=3.12',
      },
      safety: {
        maxIterations: 3,
        flashRequiresApproval: true,
        powerNote: QUICK_START_POWER_NOTE,
      },
      connectionChecklist: [
        {
          label: 'Board powered (3V3/5V confirmed)',
          detail: 'The board is powered and its supply rail measures the expected voltage.',
        },
        {
          label: 'Debug probe connected',
          detail: 'The debug probe is attached to the target and enumerated on the runner host.',
        },
        {
          label: 'Serial cable connected',
          detail: 'The serial cable is connected and its port appears on the runner host.',
        },
      ],
      knownQuirks: [],
    });

    // Whatever it compiles must be contract-valid: it goes straight to POST
    // /board-profiles with no form in between.
    expect(BoardProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('seeds exactly the three universal precondition rows — never board-specific wiring', () => {
    const profile = buildQuickStartProfile({ repoPath: '/fw', name: '', bench: BENCH });
    expect(profile.connectionChecklist).toEqual([...QUICK_START_CHECKLIST]);
    expect(profile.connectionChecklist).toHaveLength(3);
    // D12's line (2026-07-28 ruling): no pin names, no sensor lines, no bus names —
    // those stay human- or agent-authored. This is the pin that fails if someone
    // "helpfully" adds an SCL/SDA row to the defaults.
    const text = profile.connectionChecklist.map((r) => `${r.label} ${r.detail}`).join(' ');
    expect(text).not.toMatch(/\bP[A-Z]\d|SCL|SDA|I2C|SPI|UART\b/);
  });

  it('falls back to make when nothing was detected (route absent, or no build file)', () => {
    expect(buildQuickStartProfile({ repoPath: '/fw', name: 'fw', bench: BENCH }).buildCommand).toBe(
      'make',
    );
    expect(
      buildQuickStartProfile({ repoPath: '/fw', name: 'fw', detectedBuild: '   ', bench: BENCH })
        .buildCommand,
    ).toBe('make');
    expect(
      buildQuickStartProfile({
        repoPath: '/fw',
        name: 'fw',
        detectedBuild: 'cmake --build',
        bench: BENCH,
      }).buildCommand,
    ).toBe('cmake --build');
  });

  it('claims nothing when the bench reports nothing: no instruments, no target, generic pyocd', () => {
    const profile = buildQuickStartProfile(
      { repoPath: '/fw/blinky', name: '', bench: EMPTY_BENCH },
      'bp_empty',
    );

    expect(profile.name).toBe('blinky'); // derived, since none was typed
    expect(profile.mcu).toBe(''); // never an assumed anything
    expect(profile.instruments).toEqual({ debugProbe: '' });
    expect(profile.flashCommand).toBe('pyocd flash firmware.elf');
    expect(profile.resetCommand).toBe('pyocd reset');
    expect(BoardProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('claims nothing when there is no bench snapshot at all', () => {
    const profile = buildQuickStartProfile({ repoPath: '/fw/blinky', name: '', bench: null });
    expect(profile.instruments).toEqual({ debugProbe: '' });
    expect(profile.mcu).toBe('');
  });

  it('references an offline probe anyway — the bench advisory reports its health, not the profile', () => {
    const offlineBench: BenchStatus = {
      ...BENCH,
      devices: BENCH.devices.map((device) =>
        device.kind === 'debug_probe' ? { ...device, state: 'offline' as const } : device,
      ),
    };
    expect(buildQuickStartProfile({ repoPath: '/fw', name: 'fw', bench: offlineBench }).instruments)
      .toMatchObject({ debugProbe: 'pyocd:stlink:066EFF383733554157254923' });
  });

  it('omits the logic analyzer when the bench has none (§4: it is optional)', () => {
    const noAnalyzer: BenchStatus = {
      ...BENCH,
      devices: BENCH.devices.filter((device) => device.kind !== 'logic_analyzer'),
    };
    expect(
      buildQuickStartProfile({ repoPath: '/fw', name: 'fw', bench: noAnalyzer }).instruments,
    ).not.toHaveProperty('logicAnalyzer');
  });
});
