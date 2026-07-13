// App shell, frame v2 (T6.1b): a persistent left sidebar (nav, recent runs, the
// runner pill) beside a slim context top bar over the routed page content —
// content stops floating in a bare viewport. The global WS runner.status feed
// still mirrors into the bench store here, riding the one shared connection.
import { useRef } from 'react';
import { Outlet } from 'react-router-dom';
import { useGlobalEvents } from '../lib/globalStream';
import { useBenchStore } from '../lib/benchStore';
import { CommandCenter } from './CommandCenter';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

// Mirror the global stream's runner.status into the bench store. Rides the one shared
// global connection (globalStream) alongside the sidebar's live run updates.
function useGlobalRunnerFeed(): void {
  const setBench = useBenchStore((state) => state.setBench);
  useGlobalEvents((event) => {
    if (event.type === 'runner.status') setBench(event.payload.bench);
  });
}

export default function Layout() {
  useGlobalRunnerFeed();
  // The scrolling content region doubles as the keyboard-navigation focus target
  // (T6.4 item 4): after a palette or shortcut navigation, CommandCenter moves focus
  // here — a stable landmark present on every route, so keyboard users land in the
  // destination's content rather than back on the control they left. tabIndex={-1}
  // makes it programmatically focusable without joining the tab order.
  const contentRef = useRef<HTMLDivElement>(null);
  // Internal-scroll app shell (T6.2b): the sidebar and top bar are non-scrolling
  // frame elements; only the content region scrolls. The top bar can never be
  // offset by a sticky-vs-document-scroll interaction, and page-level sticky
  // (the workspace rails) anchors cleanly to this scroll container.
  return (
    <div className="flex h-screen overflow-hidden bg-bg-app font-sans text-text-primary">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <div ref={contentRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <Outlet />
        </div>
      </div>
      <CommandCenter contentRef={contentRef} />
    </div>
  );
}
