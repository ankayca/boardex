// Transport error types, split out from the api client (T6.5) so a component can
// react to a command's failure mode WITHOUT importing the `api` singleton — which is
// what lets the demo path stay structurally command-incapable (no api import) while
// still sharing the workspace's rail. api.ts re-exports both for existing callers.
import type { RunStatus } from '@boardex/contract';

// HTTP 409: the command was invalid for the run's current state (§5.3). The current
// status rides along so the UI can reconcile without a crash.
export class StateConflict extends Error {
  readonly currentStatus: RunStatus;
  constructor(message: string, currentStatus: RunStatus) {
    super(message);
    this.name = 'StateConflict';
    this.currentStatus = currentStatus;
  }
}

// Any other non-2xx (or otherwise unexpected) HTTP response.
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
