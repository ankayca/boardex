// Keyboard shortcuts help overlay (BIBLE §8 T6.4 item 3): the `?` surface, listing
// every shortcut in the app. Same overlay treatment as the palette — overlay
// elevation, medium motion in, instant dismiss, Esc closes, focus trapped while open
// and restored on close (the parent owns restoration, as with the palette).
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../design/focusTrap';

interface Shortcut {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: Shortcut[];
}

// The single source of truth for what `?` shows — kept beside the handlers it
// documents (CommandCenter) so the two never drift.
const SECTIONS: readonly ShortcutSection[] = [
  {
    title: 'Global',
    shortcuts: [
      { keys: ['⌘', 'K'], label: 'Open the command palette' },
      { keys: ['g', 'r'], label: 'Go to Runs' },
      { keys: ['g', 'b'], label: 'Go to Boards' },
      { keys: ['n'], label: 'New run (from a list page)' },
      { keys: ['?'], label: 'Show this help' },
    ],
  },
  {
    title: 'In the palette',
    shortcuts: [
      { keys: ['↑', '↓'], label: 'Move between results' },
      { keys: ['↵'], label: 'Go to the selected result' },
      { keys: ['Esc'], label: 'Close' },
    ],
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded-control border border-border bg-canvas px-1.5 py-0.5 font-mono text-meta text-text-primary">
      {children}
    </kbd>
  );
}

export interface ShortcutsHelpProps {
  onClose: () => void;
}

export function ShortcutsHelp({ onClose }: ShortcutsHelpProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Shared modal focus trap (§6.2 v2.3): seeds focus on the close button (the
  // only tabbable), cycles Tab inside, and restores the invoking control on
  // close — the trap must run before anything else moves focus, so it can
  // capture the invoker.
  useFocusTrap(dialogRef);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      // Esc convention: consume with stopPropagation — topmost surface only.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-overlay-in bg-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative w-full max-w-md animate-palette-in rounded-card border border-border bg-surface p-6 shadow-overlay outline-none"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-section font-semibold text-text-primary">Keyboard shortcuts</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-control p-1.5 text-text-secondary transition-colors duration-fast ease-motion hover:bg-canvas hover:text-text-primary"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="mt-4 space-y-5">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="text-metadata font-medium uppercase tracking-wide text-text-secondary">{section.title}</p>
              <dl className="mt-2 space-y-2">
                {section.shortcuts.map((shortcut) => (
                  <div key={shortcut.label} className="flex items-center justify-between gap-4">
                    <dt className="text-body text-text-primary">{shortcut.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <Kbd key={i}>{key}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
