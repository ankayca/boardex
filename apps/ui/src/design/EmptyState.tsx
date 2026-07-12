import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Usually a primary Button pointing at the one useful next step. */
  action?: ReactNode;
  /** Appended classes — e.g. a page tightening the vertical padding. */
  className?: string;
}

export function EmptyState({ title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-card border border-border bg-bg-panel px-6 py-12 text-center ${className}`}
    >
      <p className="text-section font-medium text-text-primary">{title}</p>
      {description && <p className="max-w-md text-body text-text-secondary">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
