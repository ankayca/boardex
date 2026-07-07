import type { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Optional section heading rendered above the card body. */
  heading?: string;
}

export function Card({ heading, className = '', children, ...rest }: CardProps) {
  return (
    <section
      className={`rounded-card border border-border bg-bg-panel p-6 shadow-subtle ${className}`}
      {...rest}
    >
      {heading && <h3 className="mb-4 text-section font-semibold text-text-primary">{heading}</h3>}
      {children}
    </section>
  );
}
