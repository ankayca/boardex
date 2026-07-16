// Runner endpoint configuration. The mock runner (and later the real runner) listens
// on a fixed local port — BIBLE §5.6 defaults to 4319. Override at build time with
// VITE_RUNNER_URL, or at RUNTIME via Settings (T6.6): a user-set runner URL outranks
// the env default. Precedence, resolved on every call so a runtime change re-points
// every HTTP and WS caller: user override > VITE_RUNNER_URL > default.
import { getRunnerUrlOverride } from './settings';

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

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The build-time/default base: VITE_RUNNER_URL (Vite env, then the node-test env
 * fallback), else the §5.6 default. This is the value a fresh reload starts from and
 * the fallback whenever the user clears their runner-URL override — no override applied.
 */
export function getEnvRunnerHttpBase(): string {
  return stripTrailingSlash(env?.VITE_RUNNER_URL ?? processEnv?.VITE_RUNNER_URL ?? DEFAULT_RUNNER_URL);
}

/**
 * The EFFECTIVE HTTP base every runtime caller resolves against: a user-set runner URL
 * (Settings, T6.6) wins; empty falls back to the env base. Read fresh on each call so a
 * runtime change re-points the api singleton and both WS clients — nothing captures it.
 */
export function getRunnerHttpBase(): string {
  return getRunnerUrlOverride() ?? getEnvRunnerHttpBase();
}

export function httpBaseToWs(httpBase: string): string {
  return httpBase.replace(/^http/, 'ws');
}

export function getRunnerWsBase(): string {
  return httpBaseToWs(getRunnerHttpBase());
}
