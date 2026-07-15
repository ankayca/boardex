// The demo's RunCommands (T6.5) — the local stand-in the workspace rail issues its
// stop / resolve-approval through inside the demo shell. It imports no api client and
// cannot reach a runner. This is the demo's structural command-safety guarantee — the
// same "never executes a real command" spirit the command palette enforces by type.
//
// The three verbs the rail can invoke map to honest demo behaviour, never fabricated
// events:
//   • stop   → exit the demo (its Stop merely leaves the replay).
//   • approve → fast-forward playback to the recording's OWN resolution of that gate.
//   • reject  → exit with an honest notice (F1). The recording was approved, so there
//     is no rejected ending to play; rejecting cannot continue the recording, and
//     inventing a run.stopped would be a fabricated event. It leaves instead.
import type { RunCommands } from '../lib/runCommands';

export interface DemoCommandHandlers {
  /** Leave the demo (the rail's Stop Run). */
  exit: () => void;
  /** Fast-forward through the recorded resolution of this approval (approve). */
  resolve: (approvalId: string) => void;
  /** Reject at the gate: surface the honest "this recording was approved" notice and exit. */
  reject: () => void;
}

export function makeDemoCommands({ exit, resolve, reject }: DemoCommandHandlers): RunCommands {
  return {
    stop: async () => {
      exit();
    },
    resolveApproval: async (_runId, approvalId, status) => {
      if (status === 'rejected') {
        reject();
        return;
      }
      resolve(approvalId);
    },
  };
}
