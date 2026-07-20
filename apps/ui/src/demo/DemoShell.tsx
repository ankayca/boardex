// The read-only demo shell (T6.5). Its own slim frame — NOT the app Layout — so no
// api-bound sidebar, top bar, or command center sits on the demo path. A top bar
// carries the "Demo — replaying a recorded agent run" badge, the playback controls
// (pause/resume, skip to end), and the exit; the routed demo content scrolls beneath.
import type { ReactNode } from 'react';
import { Button } from '../design';
import type { DemoPlayback } from './useDemoPlayback';

export interface DemoShellProps {
  playback: DemoPlayback;
  onExit: () => void;
  children: ReactNode;
}

export function DemoShell({ playback, onExit, children }: DemoShellProps) {
  const { status } = playback;
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas font-sans text-text-primary">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-canvas px-3 py-1 text-meta">
          <span className="font-medium text-text-primary">Demo</span>
          <span className="text-text-secondary">replaying a recorded agent run</span>
        </span>
        <div className="flex items-center gap-2">
          {status === 'ended' ? (
            <span role="status" className="text-meta text-text-secondary">
              Demo complete
            </span>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => (status === 'paused' ? playback.resume() : playback.pause())}
              >
                {status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
              <Button variant="secondary" onClick={playback.skipToEnd}>
                Skip to end
              </Button>
            </>
          )}
          {/* Stop/exit is the demo's escape hatch — it issues no runner command. */}
          <Button variant="secondary" onClick={onExit}>
            Exit demo
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
