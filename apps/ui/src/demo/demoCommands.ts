// The demo's RunCommands (T6.5) — the local stand-in the workspace rail issues its
// stop / resolve-approval through inside the demo shell. It imports no api client and
// cannot reach a runner: Stop exits the demo, and approving (or rejecting) an approval
// fast-forwards playback to the recording's OWN resolution. This is the demo's
// structural command-safety guarantee — the same "never executes a real command"
// spirit the command palette enforces by type.
import type { RunCommands } from '../lib/runCommands';

export interface DemoCommandHandlers {
  /** Leave the demo (the rail's Stop Run). */
  exit: () => void;
  /** Fast-forward through the recorded resolution of this approval. */
  resolve: (approvalId: string) => void;
}

export function makeDemoCommands({ exit, resolve }: DemoCommandHandlers): RunCommands {
  return {
    stop: async () => {
      exit();
    },
    resolveApproval: async (_runId, approvalId) => {
      resolve(approvalId);
    },
  };
}
