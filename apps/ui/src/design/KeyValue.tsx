import type { ReactNode } from 'react';

export interface KeyValueProps {
  label: string;
  value: ReactNode;
  /** Render the value in JetBrains Mono (§6.1: values are monospace). */
  mono?: boolean;
}

export function KeyValue({ label, value, mono = false }: KeyValueProps) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-1.5">
      <span className="shrink-0 text-meta text-text-secondary">{label}</span>
      <span
        className={`text-right text-text-primary ${mono ? 'font-mono text-meta' : 'text-body'}`}
      >
        {value}
      </span>
    </div>
  );
}
