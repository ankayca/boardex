// The mock runner server (BIBLE §5.3 / §5.6): a node:http Command API plus a `ws`
// event stream, backed by in-memory state seeded from the BME280 fixture. No
// Express. createMockRunner() returns a handle tests can start and close.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CONTRACT_VERSION,
  CreateRunRequestSchema,
  ResolveApprovalRequestSchema,
  SaveBoardProfileRequestSchema,
  type BenchStatus,
  type BoardProfile,
  type Event,
  type HealthResponse,
} from '@boardex/contract';
import { buildBenchStatus, DOCUMENT_CATALOG, NUCLEO_F303RE_PROFILE } from './data';
import { buildArtifactCatalog, loadFixture, type ArtifactFile } from './fixture';
import { RunSession, type CommandResult } from './session';

export interface MockRunnerOptions {
  port?: number;
  host?: string;
  speed?: number;
  degraded?: boolean;
  // Replay the fail variant (T5.0/F9): iteration 2's checks fail again and the
  // run ends in run.failed with no further fix approval.
  failVariant?: boolean;
  // Validate every outbound event against the contract at send time (§5.6). On by
  // default; a conforming runner never trips it, so a throw here is a real defect.
  validateOutbound?: boolean;
}

export interface MockRunner {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_PORT = 4319;

// v2.1 (T6.3, riding along for T6.6): the mock advertises one model so the
// composer's feature-detected model select has something to render (§5.3).
const MOCK_CAPABILITIES: { models: string[] } = { models: ['mock-model'] };

export async function createMockRunner(options: MockRunnerOptions = {}): Promise<MockRunner> {
  const speed = options.speed ?? 1;
  const degraded = options.degraded ?? false;
  const validateOutbound = options.validateOutbound ?? true;

  const fixture = loadFixture(options.failVariant ? 'fail' : 'default');
  const artifactCatalog = buildArtifactCatalog(fixture);
  const bench: BenchStatus = buildBenchStatus(degraded);

  // In-memory state (§D8: the mock persists nothing beyond fixture state in memory).
  const boardProfiles = new Map<string, BoardProfile>([
    [NUCLEO_F303RE_PROFILE.id, NUCLEO_F303RE_PROFILE],
  ]);
  const sessions = new Map<string, RunSession>();
  // Latest artifact meta by id (re-keyed to the emitting run); seeded from the
  // fixture so /artifacts/{id}/meta answers even before any run starts.
  const artifactMeta = new Map(
    [...artifactCatalog].map(([id, file]) => [id, file.meta] as const),
  );

  // WebSocket subscribers: one set per run, plus the global dashboard set.
  const runClients = new Map<string, Set<WebSocket>>();
  const globalClients = new Set<WebSocket>();
  let globalSeq = 0;

  function broadcast(clients: Set<WebSocket> | undefined, event: Event): void {
    if (!clients || clients.size === 0) return;
    const message = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    }
  }

  // Fan out a session event: per-run subscribers get everything; the global
  // dashboard gets the run-lifecycle events — run.created, run.status_changed,
  // and the dedicated terminals run.completed/run.failed/run.stopped (§5.3 v2.0:
  // a run that ends via its terminal event must reach the dashboard without a
  // redundant run.status_changed riding along).
  const GLOBAL_EVENT_TYPES = new Set([
    'run.created',
    'run.status_changed',
    'run.completed',
    'run.failed',
    'run.stopped',
  ]);

  function dispatch(session: RunSession, event: Event): void {
    if (event.type === 'artifact.created') {
      artifactMeta.set(event.payload.artifact.id, event.payload.artifact);
    }
    broadcast(runClients.get(session.id), event);
    if (GLOBAL_EVENT_TYPES.has(event.type)) {
      broadcast(globalClients, event);
    }
  }

  function newRunId(): string {
    return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function createRun(model?: string): string {
    const id = newRunId();
    const session = new RunSession({
      id,
      entries: fixture,
      speed,
      validateOutbound,
      // v2.1 (T6.3): echo the chosen model onto the run.created Run (§4 Run.model).
      model,
      onEvent: (event) => dispatch(session, event),
    });
    sessions.set(id, session);
    session.start();
    return id;
  }

  // --- HTTP -----------------------------------------------------------------

  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch(() => sendError(res, 500, 'internal error'));
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(req, res);
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const seg = url.pathname.split('/').filter(Boolean);

    // GET /health
    if (method === 'GET' && seg.length === 1 && seg[0] === 'health') {
      const body: HealthResponse = {
        ok: true,
        contractVersion: CONTRACT_VERSION,
        runnerKind: 'mock',
        capabilities: MOCK_CAPABILITIES,
      };
      return sendJson(res, 200, body);
    }

    // GET /bench
    if (method === 'GET' && seg.length === 1 && seg[0] === 'bench') {
      return sendJson(res, 200, bench);
    }

    // GET/POST /board-profiles
    if (seg.length === 1 && seg[0] === 'board-profiles') {
      if (method === 'GET') return sendJson(res, 200, [...boardProfiles.values()]);
      if (method === 'POST') {
        const parsed = SaveBoardProfileRequestSchema.safeParse(await readBody(req));
        if (!parsed.success) return sendError(res, 400, 'invalid board profile');
        boardProfiles.set(parsed.data.id, parsed.data);
        return sendJson(res, 200, parsed.data);
      }
      return sendError(res, 405, 'method not allowed');
    }

    // /runs and subroutes
    if (seg[0] === 'runs') {
      // GET /runs
      if (seg.length === 1 && method === 'GET') {
        return sendJson(res, 200, [...sessions.values()].map((s) => s.summary()));
      }
      // POST /runs
      if (seg.length === 1 && method === 'POST') {
        const parsed = CreateRunRequestSchema.safeParse(await readBody(req));
        if (!parsed.success) return sendError(res, 400, 'invalid create-run request');
        // The mock replays the canned BME280 story re-keyed with a fresh runId
        // (§5.6); the request's taskPrompt/boardProfileId are not substituted. The
        // chosen model (v2.1) IS honored — echoed onto the run.created Run.
        return sendJson(res, 200, { runId: createRun(parsed.data.model) });
      }

      const runId = seg[1];
      const session = runId ? sessions.get(runId) : undefined;

      // GET /runs/{id}/events?afterSeq=N
      if (seg.length === 3 && seg[2] === 'events' && method === 'GET') {
        if (!session) return sendError(res, 404, 'run not found');
        const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0');
        const events = session.getEventsAfter(Number.isFinite(afterSeq) ? afterSeq : 0);
        return sendJson(res, 200, events);
      }
      // POST /runs/{id}/stop
      if (seg.length === 3 && seg[2] === 'stop' && method === 'POST') {
        if (!session) return sendError(res, 404, 'run not found');
        return sendCommand(res, session.stop());
      }
      // POST /runs/{id}/plan/approve
      if (seg.length === 4 && seg[2] === 'plan' && seg[3] === 'approve' && method === 'POST') {
        if (!session) return sendError(res, 404, 'run not found');
        return sendCommand(res, session.approvePlan());
      }
      // POST /runs/{id}/approvals/{aid}
      if (seg.length === 4 && seg[2] === 'approvals' && method === 'POST') {
        if (!session) return sendError(res, 404, 'run not found');
        const parsed = ResolveApprovalRequestSchema.safeParse(await readBody(req));
        if (!parsed.success) return sendError(res, 400, 'invalid approval resolution');
        return sendCommand(res, session.resolveApproval(seg[3] as string, parsed.data.status));
      }

      if (!session) return sendError(res, 404, 'run not found');
      return sendError(res, 404, 'unknown run route');
    }

    // /artifacts/{id} and /artifacts/{id}/meta
    if (seg[0] === 'artifacts' && seg.length >= 2 && method === 'GET') {
      const id = seg[1] as string;
      if (seg.length === 3 && seg[2] === 'meta') {
        const meta = artifactMeta.get(id);
        if (!meta) return sendError(res, 404, 'artifact not found');
        return sendJson(res, 200, meta);
      }
      if (seg.length === 2) {
        return sendArtifact(res, id, artifactCatalog.get(id));
      }
    }

    // v2.1 (T6.3) — /documents/{id} and /documents/{id}/meta. Content is served
    // with Content-Type per BoardDocument.mimeType, mirroring /artifacts.
    if (seg[0] === 'documents' && seg.length >= 2 && method === 'GET') {
      const id = seg[1] as string;
      const doc = DOCUMENT_CATALOG.get(id);
      if (seg.length === 3 && seg[2] === 'meta') {
        if (!doc) return sendError(res, 404, 'document not found');
        return sendJson(res, 200, doc.meta);
      }
      if (seg.length === 2) {
        if (!doc) return sendError(res, 404, `document "${id}" not found`);
        const content = Buffer.from(doc.content, 'utf8');
        res.writeHead(200, { 'Content-Type': doc.meta.mimeType, 'Content-Length': content.length });
        res.end(content);
        return;
      }
    }

    return sendError(res, 404, 'not found');
  }

  function sendArtifact(res: ServerResponse, id: string, file: ArtifactFile | undefined): void {
    if (!file) {
      sendError(res, 404, `artifact "${id}" not found`);
      return;
    }
    let content: Buffer;
    try {
      content = readFileSync(file.filePath);
    } catch {
      sendError(res, 404, `artifact "${id}" content missing`);
      return;
    }
    // Content-Type per artifact.mimeType (§5.3).
    res.writeHead(200, { 'Content-Type': file.meta.mimeType, 'Content-Length': content.length });
    res.end(content);
  }

  // --- WebSocket ------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachWs(ws, url));
  });

  function attachWs(ws: WebSocket, url: URL): void {
    // WS /ws?global=1 — dashboard feed: a runner.status snapshot on connect, then
    // run.created + run.status_changed for all runs (§5.3).
    if (url.searchParams.get('global') === '1') {
      globalClients.add(ws);
      const snapshot: Event = {
        seq: ++globalSeq,
        runId: '_global',
        ts: new Date().toISOString(),
        type: 'runner.status',
        payload: { bench },
      };
      ws.send(JSON.stringify(snapshot));
      ws.on('close', () => globalClients.delete(ws));
      return;
    }
    // WS /ws?runId={id} — live event tail for one run. Backlog is served over HTTP
    // (GET /runs/{id}/events?afterSeq=), so this stream carries live events only.
    const runId = url.searchParams.get('runId');
    if (!runId || !sessions.has(runId)) {
      ws.close(1008, 'unknown runId');
      return;
    }
    let clients = runClients.get(runId);
    if (!clients) {
      clients = new Set();
      runClients.set(runId, clients);
    }
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  }

  // --- lifecycle ------------------------------------------------------------

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port ?? DEFAULT_PORT, options.host ?? '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? DEFAULT_PORT);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const session of sessions.values()) session.dispose();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// --- HTTP helpers -----------------------------------------------------------

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Dev CORS: allow the Vite dev origin. Any localhost / 127.0.0.1 origin is
// reflected (Vite's port varies); otherwise the standard dev origin is allowed.
function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allowed =
    origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ? origin
      : 'http://localhost:5173';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}

// A CommandResult maps to 204 on success or a 409 { error, currentStatus } (§5.3).
function sendCommand(res: ServerResponse, result: CommandResult): void {
  if (result.ok) {
    res.writeHead(204);
    res.end();
    return;
  }
  sendJson(res, 409, { error: result.error, currentStatus: result.currentStatus });
}
