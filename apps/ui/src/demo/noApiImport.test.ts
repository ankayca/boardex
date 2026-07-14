// Structural command-safety (T6.5). The demo's shell, playback engine, and command
// implementation must not import the api client — that is what makes the demo
// incapable of issuing a real command, the same "never executes" guarantee the command
// palette enforces by its type. The ONLY demo module allowed to touch lib/api is the
// read-only artifact bridge (demoArtifactSource), which registers content for
// by-reference reads and issues no command; it is deliberately excluded here.
//
// Sources are read via import.meta.glob (?raw) so the check resolves through the
// bundler, independent of the test's runtime environment.
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob('./*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function source(basename: string): string {
  const key = Object.keys(SOURCES).find((path) => path.endsWith(`/${basename}`));
  if (key === undefined) throw new Error(`demo source not found: ${basename}`);
  return SOURCES[key]!;
}

const COMMAND_PATH_MODULES = [
  'useDemoPlayback.ts',
  'demoCommands.ts',
  'DemoShell.tsx',
  'DemoPage.tsx',
  'Tour.tsx',
  'tour.ts',
  'pace.ts',
];

const API_IMPORT = /from\s+['"][^'"]*lib\/api['"]/;

describe('demo command path never imports the api client', () => {
  for (const module of COMMAND_PATH_MODULES) {
    it(`${module} does not import lib/api`, () => {
      expect(source(module)).not.toMatch(API_IMPORT);
    });
  }

  it('the artifact bridge is the sole, read-only exception', () => {
    // Documents the exception explicitly: if this ever stops importing lib/api the
    // demo-source registration moved, and the exclusion above should be revisited.
    const bridge = source('demoArtifactSource.ts');
    expect(bridge).toMatch(API_IMPORT);
    expect(bridge).toMatch(/setDemoArtifactSource/);
    // ...and it registers only content, never a command verb.
    expect(bridge).not.toMatch(/stopRun|resolveApproval|createRun|approvePlan/);
  });
});
