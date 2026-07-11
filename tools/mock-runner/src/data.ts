// Canned bench data the mock runner serves per BIBLE §5.6: one BoardProfile
// ("Nucleo-F303RE") and a BenchStatus whose logic analyzer can be marked offline
// via --degraded (for the readiness UI). Every field is defined in BIBLE §4 — no
// invented shapes.
import {
  BenchStatusSchema,
  BoardProfileSchema,
  CONTRACT_VERSION,
  type BenchStatus,
  type BoardProfile,
} from '@boardex/contract';

// The board profile the fixture's run.created references (boardProfileId
// "bp_nucleo_f303re"), consistent with the BME280 story in §5.5.
export const NUCLEO_F303RE_PROFILE: BoardProfile = BoardProfileSchema.parse({
  id: 'bp_nucleo_f303re',
  name: 'Nucleo-F303RE',
  mcu: 'STM32F303RE (Cortex-M4)',
  repoPath: '/bench/firmware/bme280-f303re',
  buildCommand: 'make clean && make',
  flashCommand:
    'pyocd flash --target stm32f303retx --frequency 4000000 bme280-f303re.elf',
  resetCommand: 'pyocd reset --target stm32f303retx',
  serial: { port: '/dev/ttyACM0', baud: 115200 },
  // Instruments reference the bench registry's stable device ids (§4
  // BenchStatus.devices.id), exactly as the Board Profile Builder's detected-device
  // picker writes them — so Validate Profile (§7.5) resolves both against a healthy
  // bench instead of warning about a name it cannot match.
  instruments: {
    debugProbe: 'pyocd:stlink:066EFF383733554157254923',
    logicAnalyzer: 'sigrok:kingst-la2016:conn=3.12',
  },
  safety: {
    maxIterations: 3,
    flashRequiresApproval: true,
    powerNote: 'Manual power: board powered over USB, 3V3 confirmed.',
  },
  connectionChecklist: [
    { label: 'SCL — PB8', detail: 'Nucleo PB8 (CN10-3) to BME280 SCL' },
    { label: 'SDA — PB9', detail: 'Nucleo PB9 (CN10-5) to BME280 SDA' },
    { label: 'VCC — 3V3', detail: 'Nucleo 3V3 (CN7-16) to BME280 VCC' },
    { label: 'GND', detail: 'Nucleo GND (CN7-20) to BME280 GND' },
    { label: 'SDO — GND', detail: 'BME280 SDO tied low to select I2C address 0x76' },
    { label: 'Logic analyzer', detail: 'Kingst LA2016 D0→SCL, D1→SDA, GND common' },
  ],
  knownQuirks: [
    'BMP280 clones report chip id 0x58; this board uses a genuine BME280 (0x60).',
    '8 MHz HSI clock — I2C1 TIMINGR must be recomputed if the clock tree changes.',
  ],
});

// The bench snapshot. `degraded` marks the logic analyzer offline so the
// readiness UI can be exercised (§5.6).
export function buildBenchStatus(degraded: boolean): BenchStatus {
  return BenchStatusSchema.parse({
    runnerOnline: true,
    contractVersion: CONTRACT_VERSION,
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
        state: degraded ? 'offline' : 'online',
        detail: degraded ? 'Not detected by sigrok' : '16 channels, sampling to 200 MHz',
      },
    ],
  });
}
