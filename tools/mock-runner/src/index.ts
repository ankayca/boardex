// tools/mock-runner entrypoint. Starts the fixture-replay server (BIBLE §5.3/§5.6).
//   SPEED=<n>     scale replay delays for demos/tests (default 1.0)
//   PORT=<n>      HTTP/WS port (default 4319)
//   --degraded    mark the logic analyzer offline (readiness-UI testing)
import { createMockRunner } from './server';

const speed = Number(process.env.SPEED) || 1;
const port = Number(process.env.PORT) || undefined;
const degraded = process.argv.includes('--degraded');

const runner = await createMockRunner({ speed, port, degraded });

console.log(
  `mock runner listening on ${runner.url}` +
    (degraded ? ' (--degraded: logic analyzer offline)' : '') +
    (speed !== 1 ? ` (SPEED=${speed})` : ''),
);

const shutdown = (): void => {
  void runner.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
