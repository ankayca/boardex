// Keyboard-first control layer (BIBLE §8 T6.4): owns the command palette and the
// shortcuts help overlay, the global shortcut handlers, and focus restoration. Mounted
// once in the app shell (Layout), so ⌘K and the global shortcuts work on every screen.
//
// Focus discipline (item 4): opening captures the focused element; a DISMISS returns
// focus there, while a NAVIGATION hands focus to the destination's main region (the
// stable content container, passed as contentRef) — every palette-reachable
// destination therefore has a sane focus target on arrival.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CommandPalette, type CloseReason } from './CommandPalette';
import { ShortcutsHelp } from './ShortcutsHelp';

// Bare-key / chord shortcuts are suppressed while an input, textarea, select, or any
// contenteditable holds focus — typing must never trigger navigation (item 3).
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

// `n` (New Run) fires from list pages only — never mid-run, never in the composer.
function isListPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/boards';
}

// The window between `g` and its second key. Generous enough for a deliberate chord,
// short enough that a stray `g` doesn't arm navigation indefinitely.
const CHORD_WINDOW_MS = 1200;

export interface CommandCenterProps {
  /** The shell's main content region — focus lands here after a palette navigation. */
  contentRef: RefObject<HTMLElement | null>;
}

export function CommandCenter({ contentRef }: CommandCenterProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // The element focused when an overlay opened — restored on dismiss.
  const openerRef = useRef<HTMLElement | null>(null);

  // Live refs so the one window listener never re-binds (and never captures stale
  // open/pathname state).
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  const focusMain = useCallback(() => contentRef.current?.focus(), [contentRef]);

  const openPalette = useCallback(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    setHelpOpen(false);
    setPaletteOpen(true);
  }, []);

  const openHelp = useCallback(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    setPaletteOpen(false);
    setHelpOpen(true);
  }, []);

  const closePalette = useCallback(
    (reason: CloseReason) => {
      setPaletteOpen(false);
      if (reason === 'navigate') focusMain();
      else openerRef.current?.focus?.();
    },
    [focusMain],
  );

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    openerRef.current?.focus?.();
  }, []);

  // Shortcut-driven navigation lands focus in the destination's main region, same as
  // a palette navigation — keyboard users never get stranded on the element they left.
  const go = useCallback(
    (to: string) => {
      navigate(to);
      focusMain();
    },
    [navigate, focusMain],
  );

  useEffect(() => {
    let pendingG = false;
    let chordTimer: number | undefined;
    const clearChord = () => {
      pendingG = false;
      if (chordTimer !== undefined) window.clearTimeout(chordTimer);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘K / Ctrl+K toggles the palette — works everywhere, including inside inputs:
      // it carries a modifier, so it never collides with typing (item 1 is app-wide).
      if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        if (paletteOpenRef.current) closePalette('dismiss');
        else openPalette();
        return;
      }

      // While an overlay is open it owns its own keys (Esc, arrows, Enter).
      if (paletteOpenRef.current || helpOpenRef.current) return;

      // Suppress every bare/chord shortcut while typing (item 3).
      if (isEditableTarget(event.target)) return;
      // Never hijack the browser's own modifier chords for the bare shortcuts below.
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (pendingG) {
        clearChord();
        if (event.key === 'r') {
          event.preventDefault();
          go('/');
          return;
        }
        if (event.key === 'b') {
          event.preventDefault();
          go('/boards');
          return;
        }
        // Any other key ends the chord without acting; fall through to re-evaluate it.
      }

      if (event.key === 'g') {
        pendingG = true;
        chordTimer = window.setTimeout(() => {
          pendingG = false;
        }, CHORD_WINDOW_MS);
        return;
      }
      if (event.key === 'n' && isListPath(pathnameRef.current)) {
        event.preventDefault();
        go('/runs/new');
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        openHelp();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearChord();
    };
  }, [openPalette, closePalette, openHelp, go]);

  return (
    <>
      {paletteOpen && <CommandPalette onClose={closePalette} />}
      {helpOpen && <ShortcutsHelp onClose={closeHelp} />}
    </>
  );
}
