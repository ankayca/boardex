// Inline bench readiness for the composer (BIBLE §7.2): a compact device list from
// runner.status, and — when any device is not online — the amber degraded warning
// listing the offline devices. Composing stays allowed; the same warning is repeated
// at approval time (PlanReview renders DegradedBenchWarning again).
import type { BenchStatus } from '@boardex/contract';
import { StatusDot } from '../../design';
import { offlineDevices, type OfflineDevice } from './benchDevices';

// Amber per D14: a warning that needs the user's attention, never decorative.
export function DegradedBenchWarning({ devices }: { devices: readonly OfflineDevice[] }) {
  if (devices.length === 0) return null;
  return (
    <div role="status" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
      <p className="text-body font-medium text-warn">Bench degraded</p>
      <ul className="mt-1 space-y-0.5">
        {devices.map((device) => (
          <li key={device.id} className="text-meta text-text-secondary">
            {device.name} — {device.state === 'error' ? 'error' : 'offline'}
            {device.detail ? ` (${device.detail})` : ''}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-meta text-text-secondary">
        You can still compose and plan; steps that need these instruments may fail.
      </p>
    </div>
  );
}

export function BenchReadiness({ bench }: { bench: BenchStatus | null }) {
  if (!bench) {
    return <p className="text-meta text-text-secondary">Bench status unavailable.</p>;
  }
  const offline = offlineDevices(bench);
  return (
    <div className="space-y-3">
      <ul aria-label="Bench readiness" className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {bench.devices.map((device) => (
          <li key={device.id}>
            <StatusDot state={device.state} label={device.name} />
          </li>
        ))}
      </ul>
      <DegradedBenchWarning devices={offline} />
    </div>
  );
}
