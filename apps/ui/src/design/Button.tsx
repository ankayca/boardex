import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tertiary-danger'
  | 'danger'
  | 'outline-danger'
  | 'ghost';

/** §6.2 v2.3: 36px standard everywhere; 40px reserved for gate-primary actions
 * (plan approval, Approve & Continue, Approve Fix Plan). */
export type ButtonSize = 'standard' | 'gate';

// One accent for actions; red strictly for destructive/stop actions (BIBLE §6.1, D14).
// text-white on solid fills is the §6.1 surface white (#FFFFFF). Hover is guarded with
// `enabled:` so a disabled button never recolors — disabled reads as the same button
// at reduced opacity, not a different variant. outline-danger (T6.1c) is the resting
// form for ever-present destructive controls (Stop Run): quiet red outline, committing
// to the solid fill only under hover/active intent. tertiary-danger (v2.3) is the
// text-button form for destructive actions that must not sit boxed equal to a
// secondary — neutral at rest, red only under hover/focus intent (the Approval
// card's Reject).
const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white enabled:hover:bg-accent-hover',
  secondary: 'border border-border-strong bg-surface text-text-primary enabled:hover:bg-canvas',
  'tertiary-danger':
    'text-text-secondary enabled:hover:text-fail enabled:focus-visible:text-fail',
  danger: 'bg-fail text-white enabled:hover:opacity-90',
  'outline-danger':
    'border border-fail bg-transparent text-fail enabled:hover:bg-fail enabled:hover:text-white enabled:active:bg-fail enabled:active:text-white',
  ghost: 'text-text-secondary enabled:hover:bg-neutral-badge-bg enabled:hover:text-text-primary',
};

const sizeClasses: Record<ButtonSize, string> = {
  standard: 'h-9',
  gate: 'h-10',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'primary',
  size = 'standard',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-control px-4 text-body font-medium transition-colors duration-fast ease-motion disabled:cursor-not-allowed disabled:opacity-60 ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      {...rest}
    />
  );
}
