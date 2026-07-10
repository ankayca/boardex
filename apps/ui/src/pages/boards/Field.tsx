// Form field primitives for the Board Profile Builder (BIBLE §7.5). Local to this
// screen: §6.2's primitive set has no input, and one form does not justify one.
// Errors render amber — the D14 warning color; red is reserved for fail/stop.
import { useId, type ReactNode } from 'react';

const INPUT_CLASSES =
  'w-full rounded-button border border-border bg-bg-panel px-3 py-2 text-body text-text-primary focus:border-accent focus:outline-none';

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="mt-1 text-meta text-warn">
      {message}
    </p>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: string;
  /** Commands, paths and values render in JetBrains Mono (§6.1). */
  mono?: boolean;
  placeholder?: string;
  inputMode?: 'numeric';
}

export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  mono = false,
  placeholder,
  inputMode,
}: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div>
      <label htmlFor={id} className="block text-meta font-medium text-text-secondary">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(inputMode !== undefined ? { inputMode } : {})}
        className={`mt-1 ${INPUT_CLASSES} ${mono ? 'font-mono text-meta' : ''} ${
          error ? 'border-warn' : ''
        }`}
      />
      {hint && !error && <p className="mt-1 text-meta text-text-secondary">{hint}</p>}
      {error && <FieldError id={errorId} message={error} />}
    </div>
  );
}

export function ToggleField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 accent-accent"
      />
      <div>
        <label htmlFor={id} className="text-body font-medium text-text-primary">
          {label}
        </label>
        <p className="text-meta text-text-secondary">{description}</p>
      </div>
    </div>
  );
}

/** The six §7.5 sections, in order, each a card with a title and a hint line. */
export function FormSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="rounded-card border border-border bg-bg-panel p-6 shadow-subtle"
    >
      <h2 className="text-section font-semibold text-text-primary">{title}</h2>
      {hint && <p className="mt-0.5 text-meta text-text-secondary">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}
