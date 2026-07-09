// Logs-tab derivation (§7.4): sub-tabs per log-kind artifact, labels by kind +
// iteration (multi-iteration logs stay distinguishable), and the fail-closed
// text parse. Views come from the real reduceRun (D5).
import { describe, expect, it } from 'vitest';
import type { Artifact, Event } from '@boardex/contract';
import { artifactOf, envelope, run, runStep, viewFrom } from '../workspace/test-events';
import { iterationOfArtifact, logSubTabs, parseLogText } from './logs';

const logArtifact = (id: string, kind: Artifact['kind'], stepId: string): Artifact => ({
  ...artifactOf(id, kind),
  stepId,
  mimeType: 'text/plain',
});

// Two iterations, each with a build and a serial step emitting a log — the
// fixture's shape in miniature.
function twoIterationEvents(): Event[] {
  return [
    envelope(1, 'run.created', { run }),
    envelope(2, 'step.started', { step: runStep('st_build_1', 2, 'Build firmware') }),
    envelope(3, 'artifact.created', {
      artifact: logArtifact('art_build_1', 'build_log', 'st_build_1'),
    }),
    envelope(4, 'step.started', { step: runStep('st_serial_1', 3, 'Read serial') }),
    envelope(5, 'artifact.created', {
      artifact: logArtifact('art_serial_1', 'serial_log', 'st_serial_1'),
    }),
    envelope(6, 'run.iteration_started', { iteration: 2, reason: 'Applying address fix' }),
    envelope(7, 'step.started', { step: runStep('st_build_2', 2, 'Build firmware') }),
    envelope(8, 'artifact.created', {
      artifact: logArtifact('art_build_2', 'build_log', 'st_build_2'),
    }),
    envelope(9, 'step.started', { step: runStep('st_serial_2', 3, 'Read serial') }),
    envelope(10, 'artifact.created', {
      artifact: logArtifact('art_serial_2', 'serial_log', 'st_serial_2'),
    }),
    envelope(11, 'artifact.created', {
      artifact: artifactOf('art_decode', 'protocol_decode'),
    }),
  ];
}

describe('logSubTabs', () => {
  it('derives one sub-tab per log-kind artifact, in creation order, excluding other kinds', () => {
    const tabs = logSubTabs(viewFrom(twoIterationEvents()));
    expect(tabs.map((tab) => tab.artifact.id)).toEqual([
      'art_build_1',
      'art_serial_1',
      'art_build_2',
      'art_serial_2',
    ]);
  });

  it('labels multi-iteration logs distinguishably by kind + iteration', () => {
    const tabs = logSubTabs(viewFrom(twoIterationEvents()));
    expect(tabs.map((tab) => tab.label)).toEqual([
      'Build — iteration 1',
      'Serial — iteration 1',
      'Build — iteration 2',
      'Serial — iteration 2',
    ]);
  });

  it('falls back to the artifact label when the emitting step is unknown', () => {
    const view = viewFrom([
      envelope(1, 'run.created', { run }),
      envelope(2, 'artifact.created', {
        artifact: { ...logArtifact('art_orphan', 'flash_log', 'st_missing'), label: 'Flash log' },
      }),
    ]);
    expect(logSubTabs(view).map((tab) => tab.label)).toEqual(['Flash log']);
  });

  it('suffixes duplicate labels so two logs of one kind in one iteration stay distinguishable', () => {
    const view = viewFrom([
      envelope(1, 'run.created', { run }),
      envelope(2, 'step.started', { step: runStep('st_serial', 3, 'Read serial') }),
      envelope(3, 'artifact.created', {
        artifact: logArtifact('art_a', 'serial_log', 'st_serial'),
      }),
      envelope(4, 'artifact.created', {
        artifact: logArtifact('art_b', 'serial_log', 'st_serial'),
      }),
    ]);
    expect(logSubTabs(view).map((tab) => tab.label)).toEqual([
      'Serial — iteration 1',
      'Serial — iteration 1 (2)',
    ]);
  });
});

describe('iterationOfArtifact', () => {
  it('assigns steps before the iteration marker to iteration 1 and after to iteration 2', () => {
    const view = viewFrom(twoIterationEvents());
    const byId = new Map(view.artifacts.map((artifact) => [artifact.id, artifact]));
    expect(iterationOfArtifact(byId.get('art_serial_1')!, view)).toBe(1);
    expect(iterationOfArtifact(byId.get('art_build_2')!, view)).toBe(2);
  });

  it('returns null for an artifact whose step is not in the view', () => {
    const view = viewFrom([envelope(1, 'run.created', { run })]);
    expect(iterationOfArtifact(logArtifact('art_x', 'serial_log', 'st_ghost'), view)).toBeNull();
  });
});

describe('parseLogText', () => {
  it('splits lines, normalizes CRLF, and drops a single trailing newline', () => {
    expect(parseLogText('a\r\nb\nc\n')).toEqual({ ok: true, lines: ['a', 'b', 'c'] });
  });

  it('keeps interior empty lines', () => {
    expect(parseLogText('a\n\nb')).toEqual({ ok: true, lines: ['a', '', 'b'] });
  });

  it('fails closed on binary (NUL-bearing) content', () => {
    const result = parseLogText('ELF\u0000binary');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not renderable text/);
  });
});
