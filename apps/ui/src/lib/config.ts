// Runner endpoint configuration. The mock runner (and later the real runner) listens
// on a fixed local port — BIBLE §5.6 defaults to 4319. Override with VITE_RUNNER_URL.
const DEFAULT_RUNNER_URL = 'http://localhost:4319';

// import.meta.env is read through a defensive cast so this module also typechecks
// outside the Vite (vite/client) type context — e.g. in the node-flavored project
// that typechecks the transport integration test.
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

// Under vitest, import.meta.env is snapshotted before tests run, so vi.stubEnv only
// reaches process.env — integration tests stub VITE_RUNNER_URL there to point this
// module at an ephemeral mock runner. process doesn't exist in the browser; read it
// through globalThis so no node types are needed and the browser path is untouched.
const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;

export const RUNNER_HTTP_BASE: string = (
  env?.VITE_RUNNER_URL ??
  processEnv?.VITE_RUNNER_URL ??
  DEFAULT_RUNNER_URL
).replace(/\/+$/, '');

export function httpBaseToWs(httpBase: string): string {
  return httpBase.replace(/^http/, 'ws');
}

export const RUNNER_WS_BASE: string = httpBaseToWs(RUNNER_HTTP_BASE);
