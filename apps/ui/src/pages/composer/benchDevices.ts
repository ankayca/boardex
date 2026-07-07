// Degraded-bench derivation (BIBLE §7.2): which devices from the runner.status
// snapshot would degrade a run. Pure; shared by the inline readiness view and the
// approval-time repeat of the warning.
import type { BenchStatus } from '@boardex/contract';

export interface OfflineDevice {
  id: string;
  name: string;
  state: 'offline' | 'error';
  detail?: string;
}

/** Devices that would degrade a run: anything not online. */
export function offlineDevices(bench: BenchStatus | null): OfflineDevice[] {
  const devices: OfflineDevice[] = [];
  for (const device of bench?.devices ?? []) {
    if (device.state !== 'online') {
      devices.push({
        id: device.id,
        name: device.name,
        state: device.state,
        ...(device.detail !== undefined ? { detail: device.detail } : {}),
      });
    }
  }
  return devices;
}
