import type { BenchDeviceState } from '@boardex/contract';

// D14 semantics: green = the device is healthy (success), amber = offline is the
// degraded-bench warning (§7.2), red = device error (failure).
const stateClasses: Record<BenchDeviceState, string> = {
  online: 'bg-pass',
  offline: 'bg-warn',
  error: 'bg-fail',
};

export interface StatusDotProps {
  state: BenchDeviceState;
  /** Visible label next to the dot; when omitted the state name is screen-reader only. */
  label?: string;
}

export function StatusDot({ state, label }: StatusDotProps) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full transition-colors duration-fast ease-motion ${stateClasses[state]}`}
      />
      <span className={label ? 'text-meta text-text-secondary' : 'sr-only'}>{label ?? state}</span>
    </span>
  );
}
