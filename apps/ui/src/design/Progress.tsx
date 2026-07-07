export interface ProgressProps {
  /** Percent complete, 0–100 (clamped). */
  value: number;
  label?: string;
}

export function Progress({ value, label = 'Progress' }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="h-1 w-full overflow-hidden rounded-full bg-border"
    >
      <div className="h-full rounded-full bg-accent" style={{ width: `${clamped}%` }} />
    </div>
  );
}
