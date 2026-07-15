// The board profile the demo run references (T6.5). This is the canonical
// Nucleo-F303RE profile the fixture's run.created points at (boardProfileId
// "bp_nucleo_f303re") — the real values from tools/mock-runner/src/data.ts, not
// invented — so the workspace's left Board Context rail renders truthfully offline.
//
// documents are omitted on purpose: they are served by-reference from a runner
// (GET /documents/{id}), and the demo has none, so the Sources tab stays honestly
// empty rather than fail-closed on every fetch.
import type { BoardProfile } from '@boardex/contract';

export const DEMO_PROFILE: BoardProfile = {
  id: 'bp_nucleo_f303re',
  name: 'Nucleo-F303RE',
  mcu: 'STM32F303RE (Cortex-M4)',
  repoPath: '/bench/firmware/bme280-f303re',
  buildCommand: 'make clean && make',
  flashCommand: 'pyocd flash --target stm32f303retx --frequency 4000000 bme280-f303re.elf',
  resetCommand: 'pyocd reset --target stm32f303retx',
  serial: { port: '/dev/ttyACM0', baud: 115200 },
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
};
