// The one focus trap (Sprint 7 P0, §6.2): every modal surface — CommandPalette,
// ShortcutsHelp, Drawer, ConfirmDialog — traps Tab inside itself and restores
// focus to the invoking control on close. One implementation so the four
// surfaces cannot drift; pair it with the Esc convention (the surface's own
// keydown handler consumes Escape with stopPropagation, so Esc closes only the
// topmost surface — no window-level Escape listeners).
import { useEffect, type RefObject } from 'react';

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function tabbables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)];
}

export interface FocusTrapOptions {
  /**
   * Trap only while true (default). A surface with an exit animation passes its
   * `open` flag so focus restores the moment closing STARTS, not when the
   * animation finishes unmounting.
   */
  active?: boolean;
}

/**
 * While active: moves focus into the container (its first tabbable, or the
 * container itself — give it tabIndex={-1}), cycles Tab/Shift+Tab inside it,
 * and on deactivation restores focus to whatever held it before the trap
 * engaged (if that element is still in the document).
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  { active = true }: FocusTrapOptions = {},
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Respect a surface's own initial-focus choice (autoFocus, or an effect
    // that focused something inside) — only seed focus when it is still outside.
    if (!container.contains(document.activeElement)) {
      (tabbables(container)[0] ?? container).focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const order = tabbables(container);
      if (order.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = order[0] as HTMLElement;
      const last = order[order.length - 1] as HTMLElement;
      const current = document.activeElement;
      if (event.shiftKey) {
        if (current === first || current === container || !container.contains(current)) {
          event.preventDefault();
          last.focus();
        }
      } else if (current === last || !container.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Restore to the invoking control — only if it still exists on the page.
      if (previous && previous.isConnected) previous.focus();
    };
  }, [containerRef, active]);
}
