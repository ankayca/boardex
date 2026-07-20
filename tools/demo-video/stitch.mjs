// stitch.mjs — assemble the per-segment webm captures into one mp4 walkthrough.
//
// Each segment is re-encoded to identical H.264 params (1920x1080, 30fps, yuv420p)
// so the concat demuxer can stream-copy them into one file with clean cuts. Prints
// the cumulative start timestamp of every segment — the spine of SHOTLIST.md.
//
// Usage: OUT=<dir> node stitch.mjs [output.mp4]

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || join(HERE, 'out');
const REPO_ROOT = resolve(HERE, '..', '..');
const finalPath = resolve(process.argv[2] || join(REPO_ROOT, 'demo-video', 'boardex-walkthrough.mp4'));

// Filmic order (seg34 is the combined composer→run take).
const ORDER = ['seg1', 'seg2', 'seg34', 'seg5', 'seg6', 'seg7', 'seg8', 'seg9'];

// Each Playwright context records its blank about:blank page for a beat before the
// app paints — a white flash at every cut. Trim it from each segment's head. Every
// segment opens with a goto + waitFor + a dwell ≥0.9s, so the first second is a
// static hold on loaded content; dropping 1.0s lands cleanly past the blank.
const HEAD_TRIM = 1.0;

const ff = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
const probeDur = (f) =>
  Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f,
    ]).toString().trim(),
  );

const present = ORDER.filter((k) => existsSync(join(OUT, `${k}.webm`)));
if (present.length === 0) throw new Error(`no segment webms found in ${OUT}`);
if (present.length !== ORDER.length) {
  console.warn(`! missing segments: ${ORDER.filter((k) => !present.includes(k)).join(', ')}`);
}

// 1) Normalize each segment to a uniform mp4.
const mp4s = [];
for (const key of present) {
  const src = join(OUT, `${key}.webm`);
  const dst = join(OUT, `${key}.mp4`);
  process.stdout.write(`transcode ${key} … `);
  ff([
    '-i', src,
    '-ss', String(HEAD_TRIM), // frame-accurate (output seek, after -i) — drops the blank lead-in
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-an',
    dst,
  ]);
  process.stdout.write(`${probeDur(dst).toFixed(1)}s\n`);
  mp4s.push({ key, dst });
}

// 2) Concat via the demuxer (stream copy — params are already uniform).
const listFile = join(OUT, 'concat.txt');
writeFileSync(listFile, mp4s.map((m) => `file '${m.dst.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
mkdirSync(dirname(finalPath), { recursive: true });
ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', finalPath]);

// 3) Report the timeline.
const total = probeDur(finalPath);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let acc = 0;
console.log('\n=== segment timeline ===');
for (const m of mp4s) {
  const d = probeDur(m.dst);
  console.log(`${m.key.padEnd(6)} start ${fmt(acc)}  (dur ${d.toFixed(1)}s)`);
  acc += d;
}
console.log(`\nTOTAL ${fmt(total)} (${total.toFixed(1)}s) → ${finalPath}`);
