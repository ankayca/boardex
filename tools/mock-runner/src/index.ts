// tools/mock-runner entrypoint. Starts the fixture-replay server (BIBLE §5.3/§5.6).
//   SPEED=<n>       scale replay delays for demos/tests (default 1.0)
//   PORT=<n>        HTTP/WS port (default 4319)
//   FIXTURE=fail    replay the fail variant (equivalent to --fail-variant)
//   FIXTURE_FILE=<path>  replay an arbitrary recorded run (§10.3); relative to
//                        the repo root. Artifacts come from its sibling artifacts/.
//   MOCK_PROVIDER_KEY=<key>  boot with the advertised provider already configured
//                        (env-fallback simulation; stored write-only, never served back)
//   MOCK_MODELS=<a,b>    override the advertised capabilities.models (default
//                        'mock-model'), mirroring the runner's AGENT_MODELS
//   --degraded      mark the logic analyzer offline (readiness-UI testing)
//   --fail-variant  iteration 2's checks fail again; the run ends in run.failed
import { createMockRunner } from './server';

const speed = Number(process.env.SPEED) || 1;
const port = Number(process.env.PORT) || undefined;
const degraded = process.argv.includes('--degraded');
const failVariant = process.argv.includes('--fail-variant') || process.env.FIXTURE === 'fail';
const fixtureFile = process.env.FIXTURE_FILE || undefined;
const providerKey = process.env.MOCK_PROVIDER_KEY || undefined;
const models = process.env.MOCK_MODELS
  ? process.env.MOCK_MODELS.split(',')
      .map((m) => m.trim())
      .filter(Boolean)
  : undefined;

const runner = await createMockRunner({
  speed,
  port,
  degraded,
  failVariant,
  fixtureFile,
  providerKey,
  ...(models?.length ? { models } : {}),
});

console.log(
  `mock runner listening on ${runner.url}` +
    (fixtureFile ? ` (FIXTURE_FILE=${fixtureFile})` : '') +
    (degraded ? ' (--degraded: logic analyzer offline)' : '') +
    (failVariant && !fixtureFile ? ' (--fail-variant: run ends in run.failed)' : '') +
    (speed !== 1 ? ` (SPEED=${speed})` : '') +
    (models ? ` (MOCK_MODELS=${models.join(',')})` : '') +
    // The FACT that a key is set, never the key: nothing in this process prints one.
    (providerKey ? ' (MOCK_PROVIDER_KEY set: provider starts configured)' : ''),
);

const shutdown = (): void => {
  void runner.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
