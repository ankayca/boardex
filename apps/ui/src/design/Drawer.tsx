import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { useExitPresence } from './motion';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Panel width in px (details-on-demand panel, right side per §6.2). */
  widthPx?: number;
  children: ReactNode;
}

export function Drawer({ open, title, onClose, widthPx = 480, children }: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  // T6.1 motion: slide in/out at motion-medium; the hook keeps the panel
  // mounted through the exit animation (instant under reduced motion).
  const { mounted, closing } = useExitPresence(open, panelRef);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!mounted) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50">
      {/* Scrim: text-primary at 40% alpha — no colors outside §6.1. */}
      <div
        className={`absolute inset-0 bg-scrim ${closing ? 'animate-overlay-out' : 'animate-overlay-in'}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`absolute right-0 top-0 flex h-full w-full flex-col border-l border-border bg-bg-panel shadow-overlay ${closing ? 'animate-drawer-out' : 'animate-drawer-in'}`}
        style={{ maxWidth: widthPx }}
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <h2 id={titleId} className="text-section font-semibold text-text-primary">
            {title}
          </h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </aside>
    </div>
  );
}
