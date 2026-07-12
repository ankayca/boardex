import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Usually a primary Button pointing at the one useful next step. */
  action?: ReactNode;
  /** T6.1c: drop the card chrome — the hero floats directly on the canvas. */
  frameless?: boolean;
  /** Appended classes — e.g. a page positioning the hero vertically. */
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  frameless = false,
  className = '',
}: EmptyStateProps) {
  const frame = frameless ? '' : 'rounded-card border border-border bg-bg-panel';
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 px-6 py-12 text-center ${frame} ${className}`}
    >
      <p className="text-section font-medium text-text-primary">{title}</p>
      {description && <p className="max-w-md text-body text-text-secondary">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
