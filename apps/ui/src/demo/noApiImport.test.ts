// Structural command-safety (T6.5, F2). The demo cannot issue a real command because
// its modules cannot even reach the api client. Rather than list the command-path
// modules by hand — a denylist that silently misses any file added later — this walks
// EVERY module under src/demo/** and asserts none of them import lib/api or its
// api-backed liveRunCommands, in either the static `from '…'` or dynamic `import('…')`
// form. The single documented exception is the read-only artifact bridge
// (demoArtifactSource), which touches lib/api only to register content for by-reference
// reads and issues no command verb.
//
// Sources are read via import.meta.glob (?raw) so the check resolves through the
// bundler over the real files on disk, independent of the test's runtime environment —
// a new demo module is covered the moment it exists.
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// The lone module allowed to import lib/api (see file header). Excluded from the sweep,
// then asserted explicitly below so the exception can never widen unnoticed.
const EXCEPTION = 'demoArtifactSource.ts';

const isTestModule = (path: string): boolean => /\.test\.tsx?$/.test(path);

// Matches an import of lib/api, lib/liveRunCommands OR lib/credentials, in both
// `from '…'` and `import('…')` forms. The trailing quote after the module name means
// lib/apiErrors (a legitimate sibling) is NOT matched — only the api client, its live
// impl, and the credential WRITE seam are. The demo has no credential surface at all
// (it mounts neither Settings nor the composer), and this keeps it that way.
const FORBIDDEN_IMPORT =
  /(?:from\s+|import\s*\(\s*)['"][^'"]*\blib\/(?:api|liveRunCommands|credentials)['"]/;
const API_IMPORT = /from\s+['"][^'"]*lib\/api['"]/;

const swept = Object.entries(SOURCES).filter(
  ([path]) => !isTestModule(path) && !path.endsWith(`/${EXCEPTION}`),
);

describe('the demo never imports the api client, its live commands, or the credential seam', () => {
  it('sweeps at least the known command-path + data modules (glob resolved something)', () => {
    // Guards against a glob that silently matches nothing (which would pass vacuously).
    expect(swept.length).toBeGreaterThan(5);
  });

  for (const [path, src] of swept) {
    it(`${path} imports no lib/api, lib/liveRunCommands or lib/credentials`, () => {
      expect(src).not.toMatch(FORBIDDEN_IMPORT);
    });
  }

  it('the artifact bridge is the sole, read-only exception', () => {
    // Documents the exception explicitly: it DOES import lib/api, but only to register
    // content for by-reference reads — never a command verb.
    const bridge = SOURCES[
      Object.keys(SOURCES).find((path) => path.endsWith(`/${EXCEPTION}`))!
    ]!;
    expect(bridge).toMatch(API_IMPORT);
    expect(bridge).toMatch(/setDemoArtifactSource/);
    expect(bridge).not.toMatch(/stopRun|resolveApproval|createRun|approvePlan/);
  });
});
