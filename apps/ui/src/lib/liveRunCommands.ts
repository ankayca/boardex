// The live, api-backed RunCommands implementation (T6.5) — the one the real run
// workspace mounts. Kept in its own module so the demo can depend on the RunCommands
// contract (lib/runCommands) without this file, and therefore without api, on its path.
import { api } from './api';
import type { RunCommands } from './runCommands';

export const liveRunCommands: RunCommands = {
  stop: (runId) => api.stopRun(runId),
  resolveApproval: (runId, approvalId, status) =>
    api.resolveApproval(runId, approvalId, status),
};
