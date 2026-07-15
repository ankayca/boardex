// The honest reject notice (T6.5, F1). Rejecting an approval in a live run ends the
// run as Stopped — but the recorded demo run was approved, so there is no rejected
// ending to play and fabricating a run.stopped would be a lie (§5.2 events are truth).
// Instead of continuing playback, Reject surfaces this and exits the demo. Tokens only,
// overlay elevation + entrance motion, one accent for the action (no D14 colour used
// decoratively — this is neither pass, fail, nor an approval gate).
import { Button } from '../design';

export const DEMO_REJECT_NOTICE =
  'In a live run, Reject ends the run as Stopped. This recording was approved — exiting demo.';

export function DemoRejectNotice({ onExit }: { onExit: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-overlay-in bg-scrim" aria-hidden="true" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Reject ends the run"
        className="relative w-full max-w-md animate-dialog-in rounded-card border border-border bg-bg-panel p-6 shadow-overlay"
      >
        <h2 className="text-section font-semibold text-text-primary">Reject ends the run</h2>
        <p className="mt-2 text-body text-text-secondary">{DEMO_REJECT_NOTICE}</p>
        <div className="mt-6 flex justify-end">
          <Button variant="primary" onClick={onExit} autoFocus>
            Exit demo
          </Button>
        </div>
      </section>
    </div>
  );
}
