// Run command injection (T6.5). The workspace's right rail issues exactly two
// state-changing commands — stop and resolve-approval — and it gets them from this
// context instead of importing the api client directly. The live app provides an
// api-backed implementation (liveRunCommands); the demo provides a local one whose
// stop exits the demo and whose resolve fast-forwards to the recording's own
// resolution. Because the rail depends only on this context, the demo path never
// imports lib/api and is therefore structurally incapable of issuing a real command —
// the same "never executes" guarantee the command palette enforces by its type.
import { createContext, useContext, type ReactNode } from 'react';

export interface RunCommands {
  stop(runId: string): Promise<void>;
  resolveApproval(
    runId: string,
    approvalId: string,
    status: 'approved' | 'rejected',
  ): Promise<void>;
}

const RunCommandsContext = createContext<RunCommands | null>(null);

export function RunCommandsProvider({
  value,
  children,
}: {
  value: RunCommands;
  children: ReactNode;
}) {
  return <RunCommandsContext.Provider value={value}>{children}</RunCommandsContext.Provider>;
}

// Throws when no provider is mounted: a run command surface with no wired commands is
// a bug, not a silent no-op.
export function useRunCommands(): RunCommands {
  const commands = useContext(RunCommandsContext);
  if (!commands) {
    throw new Error('useRunCommands must be used within a RunCommandsProvider');
  }
  return commands;
}
