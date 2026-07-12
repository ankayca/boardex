// The thin amber reconnecting bar (BIBLE §7.3): shown while the run's WebSocket is
// dropped and retrying, gone the moment it resumes. Amber is reserved for
// warning states (D14); a reconnect is exactly that. Wired to the stream client's
// connection state — it renders only for 'reconnecting'; 'connecting' (initial),
// 'open', 'closed', and the fail-closed 'not_found' show nothing. On resume the
// reducer replays from lastSeq, so no data is lost while this bar is up.
import type { RunStreamStatus } from '../../lib/runStream';

export function ReconnectingBar({ status }: { status: RunStreamStatus }) {
  if (status !== 'reconnecting') return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 bg-warn-bg px-4 py-1.5 text-meta font-medium text-warn"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" aria-hidden="true" />
      Reconnecting to the runner…
    </div>
  );
}
