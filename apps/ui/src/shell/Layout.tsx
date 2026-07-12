// App shell, frame v2 (T6.1b): a persistent left sidebar (nav, recent runs, the
// runner pill) beside a slim context top bar over the routed page content —
// content stops floating in a bare viewport. The global WS runner.status feed
// still mirrors into the bench store here, riding the one shared connection.
import { Outlet } from 'react-router-dom';
import { useGlobalEvents } from '../lib/globalStream';
import { useBenchStore } from '../lib/benchStore';
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
  return (
    <div className="flex min-h-screen bg-bg-app font-sans text-text-primary">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <Outlet />
      </div>
    </div>
  );
}
