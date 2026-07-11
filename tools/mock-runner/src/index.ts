// tools/mock-runner entrypoint. Starts the fixture-replay server (BIBLE §5.3/§5.6).
//   SPEED=<n>       scale replay delays for demos/tests (default 1.0)
//   PORT=<n>        HTTP/WS port (default 4319)
//   FIXTURE=fail    replay the fail variant (equivalent to --fail-variant)
//   --degraded      mark the logic analyzer offline (readiness-UI testing)
//   --fail-variant  iteration 2's checks fail again; the run ends in run.failed
import { createMockRunner } from './server';

const speed = Number(process.env.SPEED) || 1;
const port = Number(process.env.PORT) || undefined;
const degraded = process.argv.includes('--degraded');
const failVariant = process.argv.includes('--fail-variant') || process.env.FIXTURE === 'fail';

const runner = await createMockRunner({ speed, port, degraded, failVariant });

console.log(
  `mock runner listening on ${runner.url}` +
    (degraded ? ' (--degraded: logic analyzer offline)' : '') +
    (failVariant ? ' (--fail-variant: run ends in run.failed)' : '') +
    (speed !== 1 ? ` (SPEED=${speed})` : ''),
);

const shutdown = (): void => {
  void runner.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
