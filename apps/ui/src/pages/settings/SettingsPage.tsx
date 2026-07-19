// Settings (§T6.6). A prose-simple, sectioned page in the ~760px reading column:
//   • Runner connection — the runner base URL as a RUNTIME setting (user value >
//     VITE_RUNNER_URL > default), a Test Connection probe against /health, and
//     Use-env-default to clear the override. A saved value re-points the whole app
//     (api singleton + both WS clients) via lib/config's resolvers.
//   • Model — the runner's advertised models, read-only (the composer picks among them
//     when it advertises more than one; feature-detected, never assumed).
//   • Appearance & behavior — collapse-sidebar-by-default and a replay-onboarding reset,
//     the existing scattered prefs folded into one place.
// Persistence is MODULE MEMORY (lib/settings) — the same mechanism the sidebar and demo
// tour already use; no storage, per the T6.6 constraint. Tokens only; D14 reserved.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, StatusDot } from '../../design';
import { api, createApiClient } from '../../lib/api';
import { getEnvRunnerHttpBase } from '../../lib/config';
import {
  getRunnerUrlOverride,
  getSidebarCollapsed,
  setRunnerUrlOverride,
  setSidebarCollapsed,
  useSettingsVersion,
} from '../../lib/settings';
import { resetTourMemory } from '../../demo/Tour';
import { classifyHealth, type ConnectionResult } from './testConnection';

type TestState =
  | { status: 'idle' }
  | { status: 'testing'; base: string }
  | { status: 'done'; base: string; result: ConnectionResult }
  | { status: 'offline'; base: string };

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-8">
      <h2 className="text-body font-semibold text-text-primary">{title}</h2>
      <p className="mt-1 max-w-prose text-meta text-text-secondary">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

// The Test Connection verdict line — its D14 tone drives the only color used here.
function TestResult({ test }: { test: TestState }) {
  if (test.status === 'idle') return null;
  if (test.status === 'testing') {
    return (
      <p role="status" className="text-meta text-text-secondary">
        Testing {test.base}…
      </p>
    );
  }
  if (test.status === 'offline') {
    // A failed reachability probe is a WARNING to resolve, not a fail/stop (D14, T6.6
    // review F1): amber dot + amber text (StatusDot 'offline' is the amber state, and
    // its sr-only label reads "offline"), never red — red stays reserved for pass/fail.
    return (
      <p role="status" className="flex items-center gap-2 text-meta text-warn">
        <StatusDot state="offline" />
        Offline — could not reach {test.base}
      </p>
    );
  }
  const { result } = test;
  // pass → green; every other verdict (mismatch/degraded) is an amber warning, dot and
  // text agreeing on the amber 'offline' state — no probe verdict ever paints red.
  const tone = result.tone === 'pass' ? 'text-pass' : 'text-warn';
  const dot = result.tone === 'pass' ? 'online' : 'offline';
  const message =
    result.kind === 'online'
      ? `Online · ${result.runnerKind} · ${result.contractVersion}`
      : result.kind === 'mismatch'
        ? `Reachable, but contract ${result.contractVersion} ≠ expected ${result.expected}`
        : `Reachable (${result.runnerKind}), but the runner reports not ready`;
  return (
    <p role="status" className={`flex items-center gap-2 text-meta ${tone}`}>
      <StatusDot state={dot} />
      {message}
    </p>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  // Re-render when module-memory settings change (Save/Reset/collapse toggle).
  useSettingsVersion();
  const override = getRunnerUrlOverride();
  const envBase = getEnvRunnerHttpBase();

  const [draft, setDraft] = useState(override ?? '');
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [tourReset, setTourReset] = useState(false);

  const normalized = normalizeUrl(draft);
  const dirty = (normalized || null) !== override;

  const health = useQuery({ queryKey: ['health'], queryFn: () => api.getHealth(), retry: false });
  const models = health.data?.capabilities?.models ?? [];

  const save = () => {
    setRunnerUrlOverride(draft); // normalizes/clears; only re-points if actually changed
    setDraft(normalized);
    setTest({ status: 'idle' }); // a stale verdict must not linger past a base change
    void queryClient.invalidateQueries(); // refetch every surface against the new base
  };

  const useEnvDefault = () => {
    setRunnerUrlOverride(null);
    setDraft('');
    setTest({ status: 'idle' });
    void queryClient.invalidateQueries();
  };

  const runTest = async () => {
    // Probe the value in the box (or the env base when empty) — no need to Save first.
    const candidate = normalizeUrl(draft) || envBase;
    setTest({ status: 'testing', base: candidate });
    try {
      const result = classifyHealth(await createApiClient(candidate).getHealth());
      setTest({ status: 'done', base: candidate, result });
    } catch {
      setTest({ status: 'offline', base: candidate });
    }
  };

  const collapsed = getSidebarCollapsed();

  return (
    <main className="mx-auto max-w-3xl px-6 pb-16 pt-10">
      <p className="text-body text-text-secondary">
        Connection and preferences. Changes apply immediately and reset on reload.
      </p>

      <div className="mt-8 space-y-8">
        <Section
          title="Runner connection"
          description="Where Boardex reaches the runner. A value here overrides the environment default; leave it empty to use the default. The change re-points every request and live stream."
        >
          <label htmlFor="runner-url" className="text-metadata font-medium uppercase tracking-wide text-text-secondary">
            Runner URL
          </label>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
              id="runner-url"
              type="url"
              inputMode="url"
              spellCheck={false}
              placeholder={envBase}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-w-0 flex-1 rounded-control border border-border bg-surface px-3 py-1.5 font-mono text-body text-text-primary focus:border-accent focus:outline-none"
            />
            <Button variant="secondary" onClick={() => void runTest()}>
              Test connection
            </Button>
            <Button variant="primary" disabled={!dirty} onClick={save}>
              Save
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-meta text-text-secondary">
              {override ? (
                <>
                  Using <span className="font-mono text-text-primary">{override}</span> (custom)
                </>
              ) : (
                <>
                  Using <span className="font-mono text-text-primary">{envBase}</span> (environment
                  default)
                </>
              )}
            </p>
            {override && (
              <Button variant="ghost" onClick={useEnvDefault}>
                Use environment default
              </Button>
            )}
          </div>
          <div className="mt-2">
            <TestResult test={test} />
          </div>
        </Section>

        <Section
          title="Model"
          description="Models the connected runner advertises. The composer shows a picker only when more than one is offered — otherwise the runner's default is used."
        >
          {models.length > 0 ? (
            <ul className="space-y-1">
              {models.map((model, index) => (
                <li key={model} className="flex items-center gap-2 text-body text-text-primary">
                  <span className="font-mono">{model}</span>
                  {index === 0 && (
                    <span className="text-metadata font-medium uppercase tracking-wide text-text-secondary">
                      default
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta text-text-secondary">
              {health.isSuccess
                ? 'The runner advertises no model options; Boardex uses the runner’s default.'
                : 'Model options are unavailable — the runner is offline.'}
            </p>
          )}
        </Section>

        <Section
          title="Appearance & behavior"
          description="Small preferences. Like everything here, these live for the session and reset on reload."
        >
          <label className="flex items-center gap-2.5 text-body text-text-primary">
            <input
              type="checkbox"
              checked={collapsed}
              onChange={(event) => setSidebarCollapsed(event.target.checked)}
              className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
            />
            Collapse the sidebar by default
          </label>

          <div className="mt-5">
            <Button
              variant="secondary"
              onClick={() => {
                resetTourMemory();
                setTourReset(true);
              }}
            >
              Replay onboarding
            </Button>
            {tourReset && (
              <p role="status" className="mt-2 text-meta text-text-secondary">
                The guided tour will play again the next time you open the demo.
              </p>
            )}
          </div>
        </Section>
      </div>
    </main>
  );
}
