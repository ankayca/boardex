import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { useFocusTrap } from './focusTrap';
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

  // Shared modal focus trap (§6.2 v2.3): active only while open AND mounted —
  // exit-presence mounts the panel one render after `open` flips, so engaging
  // on `open` alone would run against a null ref and never trap. Deactivating
  // on `open` restores focus to the invoking control the moment closing
  // starts, not after the exit animation unmounts the panel.
  useFocusTrap(panelRef, { active: open && mounted });

  // Esc convention: the surface's OWN element consumes Escape with
  // stopPropagation — only the topmost surface closes. (Element-level, not a
  // window listener: with focus trapped inside, the event always reaches the
  // panel, and a surface stacked above it stops it before it gets here.)
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  if (!mounted) {
    return null;
  }

  // Portal to <body> so the overlay escapes any ancestor stacking context. The
  // workspace rails are `position: sticky` (§6.3, T6.2b), which establishes a
  // stacking context; rendered inline, the drawer's z-50 would be scoped to its
  // sticky rail and a sibling sticky rail could paint over it. At the body level
  // the §6.1 overlay elevation sits above all sticky content unconditionally.
  return createPortal(
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
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`absolute right-0 top-0 flex h-full w-full flex-col border-l border-border bg-surface shadow-overlay outline-none ${closing ? 'animate-drawer-out' : 'animate-drawer-in'}`}
        // §6.3 v2.3: capped at 47vw so the dimmed content underneath stays visible.
        style={{ maxWidth: `min(${widthPx}px, 47vw)` }}
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
    </div>,
    document.body,
  );
}
