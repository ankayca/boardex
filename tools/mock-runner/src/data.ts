// Canned bench data the mock runner serves per BIBLE §5.6: one BoardProfile
// ("Nucleo-F303RE") and a BenchStatus whose logic analyzer can be marked offline
// via --degraded (for the readiness UI). Every field is defined in BIBLE §4 — no
// invented shapes.
import {
  BenchStatusSchema,
  BoardProfileSchema,
  CONTRACT_VERSION,
  type BenchStatus,
  type BoardDocument,
  type BoardProfile,
} from '@boardex/contract';

// v2.1 (T6.3): the two authored reference documents the canned profile carries and
// the runner serves by reference (§5.3 GET /documents/{id}). Metadata (BoardDocument)
// is stored on the profile; the bytes live in DOCUMENT_CONTENT below. Both are
// authored to be technically consistent with the BME280 fixture story and the
// house facts in servers/ (PB8/PB9 = I2C1 AF open-drain, address 0x76 with SDO=GND,
// wire byte 0x76<<1 = 0xEC, chip-id register 0xD0 -> 0x60).
export const BME280_DATASHEET_DOC: BoardDocument = {
  id: 'doc_bme280_datasheet',
  label: 'BME280 datasheet (excerpt)',
  kind: 'datasheet',
  mimeType: 'text/markdown',
};

export const SCHEMATIC_NOTES_DOC: BoardDocument = {
  id: 'doc_schematic_notes',
  label: 'Schematic notes — Nucleo-F303RE ↔ BME280',
  kind: 'schematic',
  mimeType: 'text/markdown',
};

export const NUCLEO_DOCUMENTS: BoardDocument[] = [BME280_DATASHEET_DOC, SCHEMATIC_NOTES_DOC];

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
  // v2.1 (T6.3): reference material the runner serves by id (§5.3).
  documents: NUCLEO_DOCUMENTS,
});

// --- Document content (v2.1, T6.3) ------------------------------------------
// Authored markdown served verbatim by GET /documents/{id}. The datasheet's two
// H2 headings slugify (GitHub-style) to the exact locators the fixture's
// i2c_clock / device_ack checks cite ("timing-specifications" and
// "i2c-device-addressing"), so a check's sourceDoc deep-links land on the section.

const BME280_DATASHEET_MD = `# BME280 — combined humidity and pressure sensor (datasheet excerpt)

*Reproduced for bench reference only. Section numbers follow the Bosch BME280 datasheet, rev 1.6.*

## I2C device addressing

The BME280 I2C interface uses a **7-bit device address**; the SDO pin selects its
least-significant bit (datasheet §5.4.1):

| SDO connection | 7-bit address | Write byte (RW=0) | Read byte (RW=1) |
|---|---|---|---|
| GND | \`0x76\` | \`0xEC\` | \`0xED\` |
| VDDIO | \`0x77\` | \`0xEE\` | \`0xEF\` |

On this bench SDO is tied to GND (see the schematic notes), so the device answers at
7-bit \`0x76\`. The master sends the 7-bit address in the upper seven bits of the
first byte and the R/W flag in bit 0 — the wire byte is \`(0x76 << 1) | rw\`, i.e.
\`0xEC\` to write and \`0xED\` to read.

A frequent bring-up error is passing the 7-bit value \`0x76\` straight into an 8-bit
address field that already expects the shift: the peripheral then drives \`0x76\` as
the address byte, addressing 7-bit \`0x3B\`, which nothing answers — every transaction
NACKs at the address phase. Correcting the shift to \`0xEC\` is the fix the run applies.

Chip identification: a read of register \`0xD0\` returns \`0x60\` for a genuine BME280.

## Timing specifications

The interface supports I2C standard mode and fast mode (datasheet §6.2):

| Parameter | Symbol | Min | Max | Unit |
|---|---|---|---|---|
| SCL clock frequency (standard mode) | f_SCL | 0 | 100 | kHz |
| SCL clock frequency (fast mode) | f_SCL | 0 | 400 | kHz |

Bench acceptance for this bring-up is standard mode at **100 kHz ±10% (90–110 kHz)**.
The STM32F303 I2C1 clock derives from the 8 MHz HSI; \`I2C1->TIMINGR\` must be
recomputed whenever the clock tree changes (see the profile's known quirks).
`;

const SCHEMATIC_NOTES_MD = `# Nucleo-F303RE ↔ BME280 — schematic notes

Wiring for the BME280 breakout on the Nucleo-F303RE. The bus is I2C1 on PB8/PB9
(AF4, open-drain), matching the connection checklist in the board profile.

## Pin mapping

| Net | STM32 pin | Nucleo header | BME280 | Notes |
|---|---|---|---|---|
| SCL | PB8 | CN10-3 | SCL | I2C1_SCL, AF4, open-drain, 4.7 kΩ pull-up to 3V3 |
| SDA | PB9 | CN10-5 | SDA | I2C1_SDA, AF4, open-drain, 4.7 kΩ pull-up to 3V3 |
| 3V3 | — | CN7-16 | VCC | 3.3 V supply |
| GND | — | CN7-20 | GND | common ground |
| — | — | — | SDO → GND | ties the I2C address to \`0x76\` (datasheet §5.4.1) |

Pull-ups are external on the breakout; the STM32 pins stay open-drain with no
internal pull enabled.

## Logic analyzer tap

The Kingst LA2016 (sigrok) taps the bus in parallel — it never drives it:

| LA channel | Signal |
|---|---|
| D0 | SCL |
| D1 | SDA |
| GND | common with the Nucleo GND |

Sampling at ≥ 2 MHz resolves 100 kHz SCL edges comfortably.
`;

export interface DocumentFile {
  meta: BoardDocument;
  content: string;
}

// The catalog GET /documents/{id} (+ /meta) serves from. Keyed by document id.
export const DOCUMENT_CATALOG: Map<string, DocumentFile> = new Map(
  [
    { meta: BME280_DATASHEET_DOC, content: BME280_DATASHEET_MD },
    { meta: SCHEMATIC_NOTES_DOC, content: SCHEMATIC_NOTES_MD },
  ].map((doc) => [doc.meta.id, doc] as const),
);

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
