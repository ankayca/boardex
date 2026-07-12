import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

// One accent for actions; red strictly for destructive/stop actions (BIBLE §6.1, D14).
// text-white on solid fills is the §6.1 panel white (#FFFFFF). Hover is guarded with
// `enabled:` so a disabled button never recolors — disabled reads as the same button
// at reduced opacity, not a different variant.
const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white enabled:hover:bg-accent-hover',
  secondary:
    'border border-border bg-bg-panel text-text-primary enabled:hover:border-border-strong enabled:hover:bg-bg-app',
  danger: 'bg-fail text-white enabled:hover:opacity-90',
  ghost: 'text-text-secondary enabled:hover:bg-neutral-badge-bg enabled:hover:text-text-primary',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className = '', type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-button px-4 py-2 text-body font-medium transition-colors duration-fast ease-motion disabled:cursor-not-allowed disabled:opacity-50 ${variantClasses[variant]} ${className}`}
      {...rest}
    />
  );
}
