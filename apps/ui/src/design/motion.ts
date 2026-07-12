import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Exit presence for overlay primitives (T6.1 motion): keeps the element mounted
 * while its exit animation plays, unmounting on animationend with the computed
 * animation duration as a timeout fallback. When the computed duration is 0 —
 * jsdom, or prefers-reduced-motion collapsing durations — the unmount happens
 * synchronously in the effect, so tests and reduced-motion users never wait.
 */
export function useExitPresence(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const el = ref.current;
    if (!el) {
      setMounted(false);
      return;
    }
    const duration = animationDurationMs(el);
    if (duration <= 0) {
      setMounted(false);
      return;
    }
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        setMounted(false);
      }
    };
    // Small buffer so the fallback never truncates the animation it backstops.
    const timer = window.setTimeout(finish, duration + 80);
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.target === el) {
        finish();
      }
    };
    el.addEventListener('animationend', onAnimationEnd);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener('animationend', onAnimationEnd);
    };
  }, [open, ref]);

  return { mounted, closing: mounted && !open };
}

function animationDurationMs(el: HTMLElement): number {
  const raw = getComputedStyle(el).animationDuration || '0s';
  const first = raw.split(',')[0]?.trim() ?? '0s';
  const value = parseFloat(first);
  if (Number.isNaN(value)) {
    return 0;
  }
  return first.endsWith('ms') ? value : value * 1000;
}
