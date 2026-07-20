// The guided tour callout (T6.5). A single self-narrating card anchored to the demo's
// real moments — it names the zone to look at and advances as each moment occurs (or
// on Next). Dismissible; once completed or dismissed it is never shown again, tracked
// in module memory (not storage), exactly as the ruling specifies. Tokens only, one
// accent for the action, overlay elevation + entrance motion; no D14 color is used
// decoratively.
import { useState } from 'react';
import type { RunView } from '@boardex/contract';
import { Button } from '../design';
import { TOUR_STEPS, activeTourIndex, highestReached } from './tour';

// Module memory: survives navigation within the session, resets on reload — no storage.
let tourCompleted = false;

// Test seam only — lets a test start from a clean tour.
export function resetTourMemory(): void {
  tourCompleted = false;
}

export function Tour({ view }: { view: RunView | null }) {
  const [manualIndex, setManualIndex] = useState(0);
  const [dismissed, setDismissed] = useState(tourCompleted);

  // Nothing until the run has actually started producing moments.
  if (dismissed || highestReached(view) < 0) return null;

  const activeIndex = activeTourIndex(manualIndex, view);
  const step = TOUR_STEPS[activeIndex]!;
  const isLast = activeIndex === TOUR_STEPS.length - 1;

  const complete = () => {
    tourCompleted = true;
    setDismissed(true);
  };
  const next = () => {
    if (isLast) complete();
    else setManualIndex(activeIndex + 1);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-28 z-40 flex justify-center px-4">
      <section
        aria-label="Demo tour"
        aria-live="polite"
        className="pointer-events-auto w-full max-w-sm animate-dialog-in rounded-card border border-border bg-surface p-5 shadow-overlay"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-metadata font-medium uppercase tracking-wide text-text-secondary">
            {step.zone}
          </span>
          <span className="font-mono text-meta text-text-secondary">
            {activeIndex + 1} / {TOUR_STEPS.length}
          </span>
        </div>
        <h2 className="mt-2 text-section font-semibold text-text-primary">{step.title}</h2>
        <p className="mt-1.5 text-body text-text-secondary">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={complete}>
            Dismiss
          </Button>
          <Button variant="primary" onClick={next}>
            {isLast ? 'Done' : 'Next'}
          </Button>
        </div>
      </section>
    </div>
  );
}
