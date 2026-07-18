import { useState } from 'react';
import type { ReactNode } from 'react';
import type {
  BenchDeviceState,
  CheckVerdict,
  RiskLevel,
  RunStatus,
  StepStatus,
} from '@boardex/contract';
import { CommandPalette } from '../shell/CommandPalette';
import { ShortcutsHelp } from '../shell/ShortcutsHelp';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { ConfirmDialog } from './ConfirmDialog';
import { Drawer } from './Drawer';
import { EmptyState } from './EmptyState';
import { KeyValue } from './KeyValue';
import { LogViewer } from './LogViewer';
import { Progress } from './Progress';
import { RunStatusIcon } from './RunStatusIcon';
import { StatusDot } from './StatusDot';
import { StepStatusIcon } from './StepStatusIcon';

// Typed against the contract enums so a contract change breaks typecheck here.
const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const VERDICTS: CheckVerdict[] = ['pass', 'fail', 'needs_review'];
const RUN_STATUSES: RunStatus[] = [
  'draft',
  'planning',
  'plan_ready',
  'running',
  'awaiting_approval',
  'diagnosing',
  'completed',
  'failed',
  'stopped',
];
const DEVICE_STATES: BenchDeviceState[] = ['online', 'offline', 'error'];
const STEP_STATUSES: StepStatus[] = ['pending', 'active', 'succeeded', 'failed', 'skipped'];

// Motion demo cycles — status flips a human would actually watch happen.
const MOTION_STATUSES = [
  'running',
  'awaiting_approval',
  'diagnosing',
  'completed',
  'failed',
] as const satisfies readonly RunStatus[];
const MOTION_PROGRESS = [0, 33, 66, 100] as const;
const MOTION_DEVICE_STATES = ['online', 'offline', 'error'] as const satisfies readonly BenchDeviceState[];

function useCycle<T>(values: readonly [T, ...T[]]): [T, () => void] {
  const [index, setIndex] = useState(0);
  const value = values[index % values.length] ?? values[0];
  return [value, () => setIndex((i) => (i + 1) % values.length)];
}

function makeSampleLines(): string[] {
  return Array.from(
    { length: 400 },
    (_, i) =>
      `[${String(i).padStart(4, '0')}] arm-none-eabi-gcc -mcpu=cortex-m4 -c src/module_${i % 7}.c -o build/module_${i % 7}.o`,
  );
}

function GallerySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-section font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

// Dev-only gallery: every §6.2 primitive in every state, on one plain page.
// This page is the visual regression baseline — keep it boring and exhaustive.
export default function DesignGalleryPage() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dangerConfirmOpen, setDangerConfirmOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [logLines, setLogLines] = useState<string[]>(makeSampleLines);
  const [motionStatus, cycleStatus] = useCycle(MOTION_STATUSES);
  const [motionDevice, cycleDevice] = useCycle(MOTION_DEVICE_STATES);
  const [motionProgress, cycleProgress] = useCycle(MOTION_PROGRESS);

  const appendLogLine = () =>
    setLogLines((prev) => [
      ...prev,
      `[${String(prev.length).padStart(4, '0')}] appended line ${prev.length}`,
    ]);

  // Synthetic per-line timestamps (14:03:00 + one second per line) so the gallery
  // exercises the T6.2 timestamp toggle and find-in-log header.
  const logTimestamps = logLines.map((_, i) => {
    const t = 3 * 60 + 22 + i;
    const hh = 14 + Math.floor(t / 3600);
    const mm = Math.floor((t % 3600) / 60);
    const ss = t % 60;
    return [hh, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
  });

  return (
    <main className="min-h-screen bg-canvas font-sans text-text-primary">
      <div className="mx-auto max-w-5xl space-y-8 px-8 py-10">
        <header>
          <h1 className="text-page font-semibold">Design primitives</h1>
          <p className="mt-1 text-body text-text-secondary">
            Dev-only gallery (BIBLE §6.2) — every primitive in every state. Visual regression
            baseline.
          </p>
        </header>

        <GallerySection title="Type scale & rhythm">
          <Card className="space-y-3">
            <p className="text-page font-semibold">Page title — 22/28, −0.017em</p>
            <p className="text-section font-semibold">Section / top-bar title — 15/20, −0.01em</p>
            <p className="text-body font-semibold">Card & step title — 14/20 semibold</p>
            <p className="text-body">Body — 14/20. The plan executes against the bench.</p>
            <p className="text-meta text-text-secondary">Meta — 13/18. Updated 2 minutes ago.</p>
            <p className="text-metadata text-text-secondary">Metadata — 12/16. seq 141 · iteration 2</p>
            <p className="font-mono text-code text-text-secondary">
              Code — 12.5/19 mono. i2c_clock=99.611kHz ack=1
            </p>
            <p className="text-label font-medium uppercase text-text-secondary">
              Label — 11/16, +0.05em, uppercase — machine capsules only
            </p>
          </Card>
          <Card heading="Tabular numerals" className="max-w-md">
            <p className="mb-3 text-meta text-text-secondary">
              All numerals are tabular app-wide — measurement columns align in Inter and in mono.
            </p>
            <KeyValue label="I2C clock" value="99.611 kHz" mono />
            <KeyValue label="I2C clock (retry)" value="101.337 kHz" mono />
            <KeyValue label="Boot to prompt" value="1.042 s" mono />
            <KeyValue label="Last seq" value="141" mono />
          </Card>
        </GallerySection>

        <GallerySection title="Elevation">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-card border border-border bg-surface p-5">
              <p className="text-body font-medium">resting</p>
              <p className="mt-1 text-meta text-text-secondary">
                Cards and panels — no shadow; surface + 1px border carry the depth.
              </p>
            </div>
            <div className="rounded-card border border-border bg-surface p-5 shadow-raised">
              <p className="text-body font-medium">raised</p>
              <p className="mt-1 text-meta text-text-secondary">
                Floating over content — popovers, jump-to-latest, demo callout.
              </p>
            </div>
            <div className="rounded-card border border-border bg-surface p-5 shadow-overlay">
              <p className="text-body font-medium">overlay</p>
              <p className="mt-1 text-meta text-text-secondary">
                Modal surfaces — dialogs, drawers, palette.
              </p>
            </div>
          </div>
          <p className="text-meta text-text-secondary">
            Shadows exist only on floating layers (§6.1 v2.3) — resting cards read against the
            canvas by border and surface alone.
          </p>
        </GallerySection>

        <GallerySection title="Focus">
          <p className="text-meta text-text-secondary">
            Tab through: every interactive element gets the same 2px accent ring, offset 2px
            (focus-visible only — pointer clicks don&apos;t ring). Text fields keep their
            accent-border focus instead.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
        </GallerySection>

        <GallerySection title="Button">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">Approve &amp; Continue</Button>
            <Button variant="secondary">Review Diff</Button>
            <Button variant="danger">Stop Run</Button>
            <Button variant="outline-danger">Stop Run</Button>
            <Button variant="ghost">Edit task</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled>
              Approve &amp; Continue
            </Button>
            <Button variant="secondary" disabled>
              Review Diff
            </Button>
            <Button variant="danger" disabled>
              Stop Run
            </Button>
            <Button variant="outline-danger" disabled>
              Stop Run
            </Button>
            <Button variant="ghost" disabled>
              Edit task
            </Button>
          </div>
          <p className="text-meta text-text-secondary">
            outline-danger is the resting form for ever-present destructive controls (Stop
            Run) — solid red only under hover intent. Disabled buttons keep 60% presence so
            a gated CTA never vanishes.
          </p>
        </GallerySection>

        <GallerySection title="Card">
          <Card heading="Board Context">
            <p className="text-body text-text-secondary">
              White surface with 1px border, 8px radius, no shadow — depth is the canvas behind.
            </p>
          </Card>
          <Card>
            <p className="text-body text-text-secondary">Card without a heading.</p>
          </Card>
        </GallerySection>

        <GallerySection title="Badge — risk">
          <div className="flex flex-wrap items-center gap-3">
            {RISK_LEVELS.map((risk) => (
              <Badge key={risk} kind="risk" value={risk} />
            ))}
          </div>
        </GallerySection>

        <GallerySection title="Badge — verdict">
          <div className="flex flex-wrap items-center gap-3">
            {VERDICTS.map((verdict) => (
              <Badge key={verdict} kind="verdict" value={verdict} />
            ))}
          </div>
        </GallerySection>

        <GallerySection title="Badge — status">
          <div className="flex flex-wrap items-center gap-3">
            {RUN_STATUSES.map((status) => (
              <Badge key={status} kind="status" value={status} />
            ))}
          </div>
        </GallerySection>

        <GallerySection title="StatusDot">
          <div className="flex flex-wrap items-center gap-6">
            {DEVICE_STATES.map((state) => (
              <StatusDot key={state} state={state} label={`Kingst LA2016 (${state})`} />
            ))}
            <StatusDot state="online" />
          </div>
        </GallerySection>

        <GallerySection title="StepStatusIcon">
          <div className="flex flex-wrap items-center gap-6">
            {STEP_STATUSES.map((status) => (
              <span key={status} className="inline-flex items-center gap-1.5">
                <StepStatusIcon status={status} />
                <span className="text-meta text-text-secondary">{status}</span>
              </span>
            ))}
          </div>
          <p className="text-meta text-text-secondary">
            Timeline glyphs — scan by shape, not color alone. D14 absolute: green check =
            succeeded only, red cross = failed only; active pulses on the accent.
          </p>
        </GallerySection>

        <GallerySection title="RunStatusIcon">
          <div className="flex flex-wrap items-center gap-5">
            {RUN_STATUSES.map((status) => (
              <span key={status} className="inline-flex items-center gap-1.5">
                <RunStatusIcon status={status} />
                <span className="text-meta text-text-secondary">{status}</span>
              </span>
            ))}
          </div>
          <p className="text-meta text-text-secondary">
            Run-status glyphs for dense surfaces (sidebar, Home table) — Badge&apos;s D14
            mapping as shape: amber attention exactly where a human action exists.
          </p>
        </GallerySection>

        <GallerySection title="KeyValue">
          <Card className="max-w-md">
            <KeyValue label="Board" value="Nucleo-F303RE" />
            <KeyValue label="MCU" value="STM32F303RE" />
            <KeyValue label="I2C clock" value="99.6 kHz" mono />
            <KeyValue label="Serial port" value="/dev/ttyACM0 @ 115200" mono />
          </Card>
        </GallerySection>

        <GallerySection title="Progress">
          <div className="max-w-md space-y-4">
            <Progress value={0} label="Progress 0%" />
            <Progress value={33} label="Progress 33%" />
            <Progress value={100} label="Progress 100%" />
          </div>
        </GallerySection>

        <GallerySection title="LogViewer">
          {/* T6.2: header hosts find-in-log; timestamps prop enables the toggle. */}
          <LogViewer
            lines={logLines}
            timestamps={logTimestamps}
            maxHeightPx={240}
            label="Build log"
          />
          <Button variant="secondary" onClick={appendLogLine}>
            Append line (auto-follow demo)
          </Button>
          <LogViewer lines={[]} label="Empty log" />
        </GallerySection>

        <GallerySection title="EmptyState">
          <EmptyState
            title="No runs yet"
            description="Delegate your first bring-up task and Boardex will plan it for approval."
            action={<Button variant="primary">New Run</Button>}
          />
        </GallerySection>

        <GallerySection title="ConfirmDialog">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => setConfirmOpen(true)}>
              Open confirm dialog
            </Button>
            <Button variant="danger" onClick={() => setDangerConfirmOpen(true)}>
              Open danger confirm
            </Button>
          </div>
        </GallerySection>

        <GallerySection title="Drawer">
          <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
            Open drawer
          </Button>
        </GallerySection>

        <GallerySection title="Command palette">
          <p className="text-meta text-text-secondary">
            ⌘K / Ctrl+K app-wide (T6.4): a centered overlay — overlay elevation, medium motion
            in, instant dismiss. Fuzzy search over navigation, recent runs, board profiles, and
            in-run evidence; arrows + Enter to navigate, Esc to close. Entries navigate to their
            surface and never execute an approval, stop, or any state-changing command.
          </p>
          <Button variant="secondary" onClick={() => setPaletteOpen(true)}>
            Open command palette
          </Button>
        </GallerySection>

        <GallerySection title="Keyboard shortcuts">
          <p className="text-meta text-text-secondary">
            The <code className="font-mono">?</code> help overlay (T6.4): every global and
            in-palette shortcut in one place. Same overlay treatment as the palette.
          </p>
          <Button variant="secondary" onClick={() => setShortcutsOpen(true)}>
            Open shortcuts help
          </Button>
        </GallerySection>

        <GallerySection title="Motion">
          <p className="text-meta text-text-secondary">
            Tokens: fast 120ms (hover/focus, state flips) · medium 200ms (badge transitions,
            drawer/dialog surfaces) · gentle 360ms (progress) · morph 280ms (the FAIL→PASS
            verdict moment). All motion collapses under prefers-reduced-motion — final states
            still land.
          </p>
          <Card heading="Badge state flip — fast" className="max-w-md">
            <div className="flex items-center justify-between gap-4">
              <Badge kind="status" value={motionStatus} />
              <Button variant="secondary" onClick={cycleStatus}>
                Advance state
              </Button>
            </div>
          </Card>
          <Card heading="StatusDot transition — fast" className="max-w-md">
            <div className="flex items-center justify-between gap-4">
              <StatusDot state={motionDevice} label={`Kingst LA2016 (${motionDevice})`} />
              <Button variant="secondary" onClick={cycleDevice}>
                Cycle device state
              </Button>
            </div>
          </Card>
          <Card heading="Progress — gentle" className="max-w-md">
            <Progress value={motionProgress} label={`Progress ${motionProgress}%`} />
            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="font-mono text-meta text-text-secondary">{motionProgress}%</span>
              <Button variant="secondary" onClick={cycleProgress}>
                Advance progress
              </Button>
            </div>
          </Card>
          <p className="text-meta text-text-secondary">
            Drawer (medium slide) and ConfirmDialog (fast entrance) demo their transitions from
            their sections above.
          </p>
        </GallerySection>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Approve plan?"
        description="Boardex will start executing the approved steps against the bench."
        confirmLabel="Approve Plan"
        onConfirm={() => setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
      />
      <ConfirmDialog
        open={dangerConfirmOpen}
        title="Stop this run?"
        description="The run ends immediately. Evidence collected so far is retained."
        confirmLabel="Stop Run"
        danger
        onConfirm={() => setDangerConfirmOpen(false)}
        onCancel={() => setDangerConfirmOpen(false)}
      />
      <Drawer open={drawerOpen} title="Board profile" onClose={() => setDrawerOpen(false)}>
        <KeyValue label="Board" value="Nucleo-F303RE" />
        <KeyValue label="MCU" value="STM32F303RE" />
        <KeyValue label="Flash command" value="pyocd flash build/firmware.elf" mono />
        <KeyValue label="Max iterations" value="3" />
      </Drawer>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
    </main>
  );
}
