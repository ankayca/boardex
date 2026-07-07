import { useState } from 'react';
import type { ReactNode } from 'react';
import type { BenchDeviceState, CheckVerdict, RiskLevel, RunStatus } from '@boardex/contract';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { ConfirmDialog } from './ConfirmDialog';
import { Drawer } from './Drawer';
import { EmptyState } from './EmptyState';
import { KeyValue } from './KeyValue';
import { LogViewer } from './LogViewer';
import { Progress } from './Progress';
import { StatusDot } from './StatusDot';

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
  const [logLines, setLogLines] = useState<string[]>(makeSampleLines);

  const appendLogLine = () =>
    setLogLines((prev) => [
      ...prev,
      `[${String(prev.length).padStart(4, '0')}] appended line ${prev.length}`,
    ]);

  return (
    <main className="min-h-screen bg-bg-app font-sans text-text-primary">
      <div className="mx-auto max-w-5xl space-y-8 px-8 py-10">
        <header>
          <h1 className="text-page font-semibold">Design primitives</h1>
          <p className="mt-1 text-body text-text-secondary">
            Dev-only gallery (BIBLE §6.2) — every primitive in every state. Visual regression
            baseline.
          </p>
        </header>

        <GallerySection title="Button">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">Approve &amp; Continue</Button>
            <Button variant="secondary">Review Diff</Button>
            <Button variant="danger">Stop Run</Button>
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
            <Button variant="ghost" disabled>
              Edit task
            </Button>
          </div>
        </GallerySection>

        <GallerySection title="Card">
          <Card heading="Board Context">
            <p className="text-body text-text-secondary">
              Panel on white with 1px border, 10px radius, subtle shadow only.
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
          <LogViewer lines={logLines} height={240} label="Build log" />
          <Button variant="secondary" onClick={appendLogLine}>
            Append line (auto-follow demo)
          </Button>
          <LogViewer lines={[]} height={96} label="Empty log" />
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
    </main>
  );
}
