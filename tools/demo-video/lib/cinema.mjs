// cinema.mjs — the shoot kit for the Boardex walkthrough film (chore/demo-video).
//
// Everything here exists to make a headless Chromium recording read like a human
// is driving the UI: a visible fake cursor (Playwright paints no native pointer),
// eased mouse travel with real time between steps, deliberate dwells after every
// navigation, and small-increment scrolls. Pace is tuned for VIEWING, not testing.
//
// Not shipped product. Run via tools/demo-video/record.mjs. Playwright is resolved
// from the session scratchpad (NODE_PATH), never vendored into the repo.

import { chromium } from 'playwright';

export const UI_URL = process.env.UI_URL || 'http://localhost:5356';
export const RUNNER_URL = process.env.RUNNER_URL || 'http://localhost:4356';

export const VIEWPORT = { width: 1920, height: 1080 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// The fake cursor. Injected before any app script so it survives SPA navigations.
// A soft dot + ring that tracks trusted mousemove events, with a click pulse. High
// z-index, pointer-events:none so it never intercepts the interactions it films.
const CURSOR_INIT = `
(() => {
  if (window.__cursorInstalled) return;
  window.__cursorInstalled = true;
  const install = () => {
    if (document.getElementById('__filmCursor')) return;
    const dot = document.createElement('div');
    dot.id = '__filmCursor';
    dot.style.cssText = [
      'position:fixed','left:0','top:0','width:22px','height:22px',
      'margin:-11px 0 0 -11px','border-radius:50%','pointer-events:none',
      'z-index:2147483647','transition:transform .05s linear',
      'background:radial-gradient(circle at 50% 50%, rgba(37,99,235,.95) 0 5px, rgba(37,99,235,.25) 6px 9px, rgba(37,99,235,0) 10px)',
      'box-shadow:0 0 0 1.5px rgba(37,99,235,.55), 0 1px 6px rgba(0,0,0,.35)'
    ].join(';');
    document.documentElement.appendChild(dot);
    let x = window.innerWidth/2, y = window.innerHeight/2;
    dot.style.left = x+'px'; dot.style.top = y+'px';
    window.addEventListener('mousemove', (e) => {
      x = e.clientX; y = e.clientY;
      dot.style.left = x+'px'; dot.style.top = y+'px';
    }, true);
    const pulse = () => {
      dot.animate(
        [{ transform:'scale(1)', opacity:1 }, { transform:'scale(2.1)', opacity:.55 }, { transform:'scale(1)', opacity:1 }],
        { duration: 340, easing: 'ease-out' }
      );
    };
    window.addEventListener('mousedown', pulse, true);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else { install(); }
  // Re-assert after SPA re-renders that might wipe the node.
  const iv = setInterval(install, 800);
  window.addEventListener('beforeunload', () => clearInterval(iv));
})();
`;

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// A Film wraps one browser context + page + recording, tracking cursor position so
// moves ease from wherever the pointer actually is.
export class Film {
  constructor(page, context) {
    this.page = page;
    this.context = context;
    this.x = VIEWPORT.width / 2;
    this.y = VIEWPORT.height / 2;
  }

  // Eased travel with real wall-clock between samples so motion is legible on film.
  async moveTo(x, y, { steps = 26, stepMs = 12 } = {}) {
    const sx = this.x, sy = this.y;
    for (let i = 1; i <= steps; i++) {
      const t = easeInOut(i / steps);
      const px = sx + (x - sx) * t;
      const py = sy + (y - sy) * t;
      await this.page.mouse.move(px, py);
      await sleep(stepMs);
    }
    this.x = x; this.y = y;
  }

  async moveToEl(locator, opts) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox();
    if (!box) throw new Error('moveToEl: element has no box: ' + locator);
    const cx = box.x + box.width / 2;
    const cy = Math.min(box.y + box.height / 2, VIEWPORT.height - 8);
    await this.moveTo(cx, cy, opts);
    return box;
  }

  async hover(locator, dwellMs = 700) {
    await this.moveToEl(locator);
    await locator.hover({ timeout: 4000 }).catch(() => {});
    await sleep(dwellMs);
  }

  // Move to the target, settle, then click — with a beat after so the result lands
  // on screen before the next action.
  async click(locator, { pre = 320, post = 650 } = {}) {
    await this.moveToEl(locator);
    await sleep(pre);
    await locator.click({ timeout: 8000 });
    await sleep(post);
  }

  // Human typing: focus the field, then key-by-key with jitter.
  async type(locator, text, { delay = 42, focusFirst = true } = {}) {
    if (focusFirst) { await this.click(locator, { post: 200 }); }
    await locator.pressSequentially(text, { delay });
  }

  // Small-increment wheel scroll so the motion is smooth, not a jump.
  async scroll(totalY, { steps = 14, stepMs = 55 } = {}) {
    const per = totalY / steps;
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, per);
      await sleep(stepMs);
    }
    await sleep(300);
  }

  dwell(ms) { return sleep(ms); }

  async goto(path) {
    const url = path.startsWith('http') ? path : UI_URL + path;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

// Launch one recording. `fn(film)` drives it; the finished webm path is returned.
export async function shoot(name, outDir, fn, { permissions = [] } = {}) {
  const browser = await chromium.launch({
    args: ['--force-color-profile=srgb', '--disable-gpu-vsync'],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    permissions,
    recordVideo: { dir: outDir, size: VIEWPORT },
    // reducedMotion deliberately UNSET: the motion design is under review.
  });
  await context.addInitScript(CURSOR_INIT);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const film = new Film(page, context);
  let failure = null;
  try {
    await fn(film);
  } catch (e) {
    failure = e;
  }
  const video = page.video();
  await context.close(); // finalizes the video file
  await browser.close();
  const rawPath = video ? await video.path() : null;
  return { name, rawPath, errors, failure };
}
