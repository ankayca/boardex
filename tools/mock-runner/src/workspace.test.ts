// The Quick Start path probe (mock-prototyped POST /workspace/validate, §10.5
// proposal — see docs/decisions.md 2026-07-28). Four kinds, the one-level walk, and
// path expansion, exercised against a real temporary directory tree: the probe's whole
// job is reading a filesystem, so stubbing one would test nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandPath, validateWorkspacePath } from './workspace';

let root: string;

// A tree covering every answer:
//   fw/                 Makefile          -> firmware, 'make'
//   cmake-fw/           CMakeLists.txt    -> firmware, 'cmake --build'
//   both/               Makefile + CMake  -> firmware, 'make' (make wins)
//   repo/               firmware/Makefile -> directory + suggestedPath (the run-1 case)
//   repo/docs/          (no build file)   -- ignored by the walk
//   repo/.hidden/       Makefile          -- dot-dirs are skipped
//   plain/              nothing           -> directory, no suggestion
//   ambiguous/          a/Makefile, b/Makefile -> directory, NO suggestion (two = a guess)
//   deep/               nested/inner/Makefile  -> directory, no suggestion (one level only)
//   notes.txt           a file            -> exists true, kind missing
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'boardex-workspace-'));

  mkdirSync(join(root, 'fw'));
  writeFileSync(join(root, 'fw', 'Makefile'), 'all:\n');

  mkdirSync(join(root, 'cmake-fw'));
  writeFileSync(join(root, 'cmake-fw', 'CMakeLists.txt'), 'project(fw)\n');

  mkdirSync(join(root, 'both'));
  writeFileSync(join(root, 'both', 'Makefile'), 'all:\n');
  writeFileSync(join(root, 'both', 'CMakeLists.txt'), 'project(fw)\n');

  mkdirSync(join(root, 'repo'));
  mkdirSync(join(root, 'repo', 'firmware'));
  writeFileSync(join(root, 'repo', 'firmware', 'Makefile'), 'all:\n');
  mkdirSync(join(root, 'repo', 'docs'));
  writeFileSync(join(root, 'repo', 'docs', 'README.md'), '# docs\n');
  mkdirSync(join(root, 'repo', '.hidden'));
  writeFileSync(join(root, 'repo', '.hidden', 'Makefile'), 'all:\n');

  mkdirSync(join(root, 'plain'));
  writeFileSync(join(root, 'plain', 'README.md'), '# nothing to build\n');

  mkdirSync(join(root, 'ambiguous'));
  mkdirSync(join(root, 'ambiguous', 'a'));
  writeFileSync(join(root, 'ambiguous', 'a', 'Makefile'), 'all:\n');
  mkdirSync(join(root, 'ambiguous', 'b'));
  writeFileSync(join(root, 'ambiguous', 'b', 'Makefile'), 'all:\n');

  mkdirSync(join(root, 'deep'));
  mkdirSync(join(root, 'deep', 'nested'));
  mkdirSync(join(root, 'deep', 'nested', 'inner'));
  writeFileSync(join(root, 'deep', 'nested', 'inner', 'Makefile'), 'all:\n');

  writeFileSync(join(root, 'notes.txt'), 'not a folder\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('validateWorkspacePath — the four kinds', () => {
  it('firmware: a Makefile at the path detects make', () => {
    expect(validateWorkspacePath(join(root, 'fw'))).toEqual({
      ok: true,
      exists: true,
      kind: 'firmware',
      detectedBuild: 'make',
    });
  });

  it('firmware: a CMakeLists at the path detects cmake --build', () => {
    expect(validateWorkspacePath(join(root, 'cmake-fw'))).toEqual({
      ok: true,
      exists: true,
      kind: 'firmware',
      detectedBuild: 'cmake --build',
    });
  });

  it('firmware: a Makefile beside a CMakeLists reports make (deterministic precedence)', () => {
    expect(validateWorkspacePath(join(root, 'both')).detectedBuild).toBe('make');
  });

  it('directory: exists, no build file, nothing to suggest', () => {
    expect(validateWorkspacePath(join(root, 'plain'))).toEqual({
      ok: false,
      exists: true,
      kind: 'directory',
    });
  });

  it('missing: nothing at that path', () => {
    expect(validateWorkspacePath(join(root, 'no-such-folder'))).toEqual({
      ok: false,
      exists: false,
      kind: 'missing',
    });
  });

  it('missing: a regular file exists but is nothing to build in — exists stays honest', () => {
    expect(validateWorkspacePath(join(root, 'notes.txt'))).toEqual({
      ok: false,
      exists: true,
      kind: 'missing',
    });
  });

  it('missing: an empty path', () => {
    expect(validateWorkspacePath('   ')).toEqual({ ok: false, exists: false, kind: 'missing' });
  });
});

describe('validateWorkspacePath — the one-level walk (the run-1 confusion)', () => {
  it('suggests the single subdirectory that holds a build file, with its build command', () => {
    expect(validateWorkspacePath(join(root, 'repo'))).toEqual({
      ok: false,
      exists: true,
      kind: 'directory',
      suggestedPath: join(root, 'repo', 'firmware'),
      detectedBuild: 'make',
    });
  });

  it('suggests nothing when two subdirectories qualify — two candidates is a guess', () => {
    expect(validateWorkspacePath(join(root, 'ambiguous'))).toEqual({
      ok: false,
      exists: true,
      kind: 'directory',
    });
  });

  it('walks exactly one level — a build file two levels down is not found', () => {
    expect(validateWorkspacePath(join(root, 'deep'))).toEqual({
      ok: false,
      exists: true,
      kind: 'directory',
    });
  });
});

describe('expandPath', () => {
  it('expands a leading ~ to the home directory', () => {
    expect(expandPath('~/firmware/bme280')).toBe(join(homedir(), 'firmware', 'bme280'));
    expect(expandPath('~')).toBe(homedir());
  });

  it('leaves a ~ that is not the home shorthand alone', () => {
    expect(expandPath('/bench/~backup/fw')).toBe(resolve('/bench/~backup/fw'));
  });

  it('normalizes trailing slashes and surrounding whitespace', () => {
    expect(expandPath('  /bench/firmware/  ')).toBe(resolve('/bench/firmware'));
    expect(expandPath('/bench/firmware///')).toBe(resolve('/bench/firmware'));
  });

  it('validates through the expansion: a ~ path and its expansion answer identically', () => {
    // The tmp tree is not under $HOME, so this asserts the expansion runs (a literal
    // "~/…" path would answer missing) by round-tripping a real directory instead.
    expect(validateWorkspacePath(`${join(root, 'fw')}/`)).toEqual(
      validateWorkspacePath(join(root, 'fw')),
    );
  });
});
