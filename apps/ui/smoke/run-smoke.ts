// Playwright smoke (BIBLE §8 T2.3): seed the fixture, drive the whole BME280 run
// through the REAL browser UI — every approval clicked in the UI, never over HTTP —
// and assert the run reaches Completed with three passing chips in the evidence band.
//
// This is deliberately NOT part of `npm run verify`: it stands up a Vite dev server,
// a mock runner, and a Chromium browser, none of which are hermetic like the rest of
// verify (pure tsc + eslint + vitest). Run it on demand:
//
//   npx playwright install chromium     # one-time: fetch the browser binary
//   npm run smoke                        # from the repo root
//
// Env knobs: SMOKE_SPEED (fixture delay scale, default 50), SMOKE_HEADED=1 to watch.
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type ConsoleMessage } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';

const UI_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEED = Number(process.env.SMOKE_SPEED ?? '50');
const HEADED = process.env.SMOKE_HEADED === '1';
const PROMPT =
  'Bring up the BME280 sensor over I2C on this STM32 board. Verify timing and confirm valid temperature/humidity readings over serial.';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke assertion failed: ${message}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  let runner: MockRunner | undefined;
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const consoleErrors: string[] = [];

  try {
    // 1. Mock runner seeded with the BME280 fixture.
    runner = await createMockRunner({ port: 0, speed: SPEED });
    // 2. Vite dev server, pointed at the runner via the same env var the UI reads.
    process.env.VITE_RUNNER_URL = runner.url;
    server = await createServer({
      root: UI_ROOT,
      configFile: `${UI_ROOT}vite.config.ts`,
      server: { port: 0, strictPort: false },
      logLevel: 'warn',
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local?.[0];
    assert(baseUrl, 'vite did not resolve a local URL');
    console.log(`[smoke] runner ${runner.url} · ui ${baseUrl} · SPEED=${SPEED}`);

    // 3. Chromium, viewport wide enough for the three-zone workspace grid (§6.3).
    try {
      browser = await chromium.launch({ headless: !HEADED });
    } catch (err) {
      throw new Error(
        `could not launch Chromium — run "npx playwright install chromium" first.\n${String(err)}`,
      );
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err: Error) => consoleErrors.push(err.message));

    // 4. Compose the task and create the plan.
    await page.goto(`${baseUrl}runs/new`);
    await page.getByRole('textbox', { name: 'Ask Boardex' }).fill(PROMPT);
    await page.getByRole('button', { name: 'Create Run Plan' }).click();

    // 5. Approve the plan behind the D12 connection checklist: confirm every line.
    const approvePlan = page.getByRole('button', { name: 'Approve Plan' });
    await approvePlan.waitFor({ state: 'visible', timeout: 30000 });
    const checkboxes = page.getByRole('checkbox');
    const boxCount = await checkboxes.count();
    for (let i = 0; i < boxCount; i++) await checkboxes.nth(i).check();
    await approvePlan.click();

    // 6. Drive every remaining approval through the UI — the flash Approve & Continue
    //    and the diagnosis Approve Fix Plan — until the run reaches Completed.
    const completed = page.locator('header span[data-kind="status"][data-value="completed"]');
    const deadline = Date.now() + 120000;
    while ((await completed.count()) === 0) {
      assert(Date.now() < deadline, 'run did not reach Completed within 120s');
      for (const name of ['Approve & Continue', 'Approve Fix Plan']) {
        const button = page.getByRole('button', { name });
        if ((await button.count()) > 0 && (await button.first().isEnabled().catch(() => false))) {
          await button.first().click().catch(() => undefined);
        }
      }
      await sleep(200);
    }

    // 7. Assert the completed state and three passing chips in the evidence band.
    await completed.waitFor({ state: 'visible' });
    const band = page.getByRole('region', { name: 'Evidence summary' });
    const chips = band.getByRole('listitem');
    const chipCount = await chips.count();
    assert(chipCount === 3, `expected 3 evidence chips, saw ${chipCount}`);
    const passBadges = band.locator('[data-kind="verdict"][data-value="pass"]');
    const passCount = await passBadges.count();
    assert(passCount === 3, `expected 3 PASS chips, saw ${passCount}`);

    assert(
      consoleErrors.length === 0,
      `console errors during the run:\n${consoleErrors.join('\n')}`,
    );

    console.log('[smoke] PASS — run Completed with 3 passing chips, no console errors');
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await runner?.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`[smoke] FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
