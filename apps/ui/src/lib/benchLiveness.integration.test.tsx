// Bench-snapshot liveness across a real socket drop (T4.2 review F1), end to end
// against the mock runner.
//
// The snapshot is a claim about the bench *now*, and it is only as true as the
// connection that delivered it. So: the runner dies, the global WS drops, Home's
// advisory line disappears rather than freezing on a bench nobody can see — and when
// the runner comes back the socket reconnects, a fresh runner.status lands, and the
// line returns without a reload. Nothing here touches /health: HTTP liveness is a
// different question from stream liveness, which is the whole point of the fix.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import type { ComponentType } from 'react';
import { useBenchStore } from './benchStore';

const ATTENTION = '1 instrument needs attention';

let runner: MockRunner;
let port: number;
let App: ComponentType;
const hadWebSocket = 'WebSocket' in globalThis;

async function startRunner(onPort: number): Promise<MockRunner> {
  // --degraded: the canned bench reports its logic analyzer offline, which is what the
  // attention line counts.
  return createMockRunner({ port: onPort, speed: 200, degraded: true });
}

beforeAll(async () => {
  runner = await startRunner(0);
  port = Number(new URL(runner.url).port);
  vi.stubEnv('VITE_RUNNER_URL', runner.url);
  (globalThis as Record<string, unknown>).WebSocket = WebSocket;
  App = (await import('../App')).default;
});

afterEach(() => {
  useBenchStore.setState({ bench: null, generation: 0 });
});

afterAll(async () => {
  await runner.close().catch(() => undefined);
  vi.unstubAllEnvs();
  if (!hadWebSocket) delete (globalThis as Record<string, unknown>).WebSocket;
});

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('bench snapshot liveness (integration)', () => {
  it('drops the snapshot when the runner dies and self-heals when it returns', async () => {
    renderApp();

    // A live socket delivered runner.status: the degraded analyzer is reported.
    expect(await screen.findByText(ATTENTION, undefined, { timeout: 15000 })).toBeInTheDocument();

    // The runner dies. The socket drops, the snapshot is dropped with it, and the GET
    // /bench fallback cannot re-fill it because the runner is gone.
    await runner.close();
    await waitFor(() => expect(screen.queryByText(ATTENTION)).not.toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(useBenchStore.getState().bench).toBeNull();

    // The runner comes back on the same port. The client's own backoff reconnects, the
    // runner re-sends its runner.status snapshot on connect (§5.3), and the line
    // returns — no reload, no manual retry.
    runner = await startRunner(port);
    expect(await screen.findByText(ATTENTION, undefined, { timeout: 30000 })).toBeInTheDocument();
  }, 60000);
});
