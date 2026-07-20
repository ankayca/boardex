import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { useFocusTrap } from './focusTrap';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive confirmations (e.g. Stop Run): confirm renders as danger. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Shared modal focus trap (§6.2 v2.3): Tab cycles Cancel/Confirm; focus
  // restores to the invoking control on close.
  useFocusTrap(dialogRef, { active: open });

  // Esc convention: element-level, consumed with stopPropagation — a confirm
  // stacked over a Drawer closes alone; the Drawer never sees the keypress.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  if (!open) {
    return null;
  }

  // Portal to <body> so the overlay escapes any ancestor stacking context — the
  // Stop-Run confirm lives inside the `position: sticky` status rail (§6.3), which
  // would otherwise scope this z-50 locally. Same reasoning as Drawer.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Scrim: text-primary at 40% alpha — no colors outside §6.1. Entrance
          animates at motion-fast; dismissal is instant — a confirm should get
          out of the way, not perform. */}
      <div className="absolute inset-0 animate-overlay-in bg-scrim" onClick={onCancel} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative w-full max-w-md animate-dialog-in rounded-card border border-border bg-surface p-6 shadow-overlay outline-none"
      >
        <h2 id={titleId} className="text-section font-semibold text-text-primary">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="mt-2 text-body text-text-secondary">
            {description}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          {/* Initial focus comes from the shared trap: Cancel is the first
              tabbable, so the safe action is focused — and the trap captured
              the invoking control BEFORE moving focus, so close restores it. */}
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
