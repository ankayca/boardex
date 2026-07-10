// Instruments section (BIBLE §7.5): a free-text instrument field PLUS a picker of
// devices detected on the bench. Picking one writes the device's stable registry id
// (§4 BenchStatus.devices.id) into the field, which is what makes Validate Profile
// resolve it exactly instead of guessing at a name.
import type { BenchStatus } from '@boardex/contract';
import { StatusDot } from '../../design';
import { TextField } from './Field';
import type { InstrumentKind } from '../../lib/benchReadiness';

export interface InstrumentFieldProps {
  label: string;
  kind: InstrumentKind;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: string;
  /** Null while GET /bench is in flight or unreachable: the field stays usable. */
  bench: BenchStatus | null;
}

export function InstrumentField({
  label,
  kind,
  value,
  onChange,
  error,
  hint,
  bench,
}: InstrumentFieldProps) {
  const detected = (bench?.devices ?? []).filter((device) => device.kind === kind);
  const pickerLabel = `Detected ${label.toLowerCase()}s`;

  return (
    <div>
      <TextField
        label={label}
        value={value}
        onChange={onChange}
        error={error}
        {...(hint !== undefined ? { hint } : {})}
        mono
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-meta text-text-secondary">
          {pickerLabel}
          <select
            aria-label={pickerLabel}
            value=""
            disabled={detected.length === 0}
            onChange={(event) => onChange(event.target.value)}
            className="rounded-button border border-border bg-bg-panel px-3 py-1.5 text-meta text-text-primary focus:border-accent focus:outline-none disabled:opacity-50"
          >
            <option value="" disabled>
              {detected.length === 0 ? 'None detected' : 'Use a detected device…'}
            </option>
            {detected.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} — {device.id}
              </option>
            ))}
          </select>
        </label>
        <ul className="flex flex-wrap items-center gap-x-4">
          {detected.map((device) => (
            <li key={device.id}>
              <StatusDot state={device.state} label={device.name} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
