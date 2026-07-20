import type { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Optional section heading rendered above the card body. */
  heading?: string;
}

export function Card({ heading, className = '', children, ...rest }: CardProps) {
  return (
    <section
      className={`rounded-card border border-border bg-surface p-6 ${className}`}
      {...rest}
    >
      {heading && <h3 className="mb-4 text-body font-semibold text-text-primary">{heading}</h3>}
      {children}
    </section>
  );
}
