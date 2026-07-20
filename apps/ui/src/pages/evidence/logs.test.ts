// Logs-tab derivation (§7.4, Sprint 7 P0): the Iteration × Type matrix behind
// the drawer's two compact selectors, and the fail-closed text parse. Views
// come from the real reduceRun (D5).
import { describe, expect, it } from 'vitest';
import type { Artifact, Event } from '@boardex/contract';
import { artifactOf, envelope, run, runStep, viewFrom } from '../workspace/test-events';
import { iterationOfArtifact, logMatrix, parseLogText } from './logs';

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

describe('logMatrix', () => {
  it('derives the iteration and type axes from the view, excluding non-log kinds', () => {
    const matrix = logMatrix(viewFrom(twoIterationEvents()));
    expect(matrix.iterations).toEqual([1, 2]);
    expect(matrix.kinds).toEqual(['build_log', 'serial_log']);
    expect(matrix.first?.id).toBe('art_build_1');
  });

  it('resolves every (iteration, kind) cell to its artifact, empty cells to null', () => {
    const matrix = logMatrix(viewFrom(twoIterationEvents()));
    expect(matrix.at(1, 'build_log')?.id).toBe('art_build_1');
    expect(matrix.at(1, 'serial_log')?.id).toBe('art_serial_1');
    expect(matrix.at(2, 'build_log')?.id).toBe('art_build_2');
    expect(matrix.at(2, 'serial_log')?.id).toBe('art_serial_2');
    expect(matrix.at(1, 'flash_log')).toBeNull();
    expect(matrix.at(3, 'serial_log')).toBeNull();
  });

  it('maps a log artifact back to its combo so deep links can drive the selectors', () => {
    const matrix = logMatrix(viewFrom(twoIterationEvents()));
    expect(matrix.comboOf('art_serial_2')).toEqual({ iteration: 2, kind: 'serial_log' });
    expect(matrix.comboOf('art_decode')).toBeNull();
  });

  it('keeps an artifact with an unknown step reachable through the unassigned list', () => {
    const view = viewFrom([
      envelope(1, 'run.created', { run }),
      envelope(2, 'artifact.created', {
        artifact: { ...logArtifact('art_orphan', 'flash_log', 'st_missing'), label: 'Flash log' },
      }),
    ]);
    const matrix = logMatrix(view);
    expect(matrix.iterations).toEqual([]);
    expect(matrix.unassigned.map((artifact) => artifact.id)).toEqual(['art_orphan']);
    expect(matrix.first?.id).toBe('art_orphan');
  });

  it('a cell holds the LATEST artifact of its kind; the older one still resolves its combo', () => {
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
    const matrix = logMatrix(view);
    expect(matrix.at(1, 'serial_log')?.id).toBe('art_b');
    // The deep-linked older duplicate still knows where it lives.
    expect(matrix.comboOf('art_a')).toEqual({ iteration: 1, kind: 'serial_log' });
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

  it('fails closed on NUL-free binary content (control-character dense)', () => {
    // A binary blob with no NUL bytes at all — e.g. a raw capture mislabeled
    // as a log: control characters make up far more than the threshold.
    const blob = Array.from({ length: 256 }, (_, i) => String.fromCharCode(1 + (i % 31))).join('');
    const result = parseLogText(blob);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not renderable text/);
  });

  it('strips ANSI escape sequences and renders the remaining text', () => {
    const colored = '\u001b[31mI2C1 ERROR:\u001b[0m timeout\n\u001b[1;32mOK\u001b[0m done\n';
    expect(parseLogText(colored)).toEqual({
      ok: true,
      lines: ['I2C1 ERROR: timeout', 'OK done'],
    });
  });

  it('renders clean text with a single stray control character', () => {
    // One BEL among ~60 characters of real log text sits under the threshold.
    const result = parseLogText('BME280: probing at 0x76\u0007\nI2C1: bus ready at 100 kHz\n');
    expect(result).toEqual({
      ok: true,
      lines: ['BME280: probing at 0x76\u0007', 'I2C1: bus ready at 100 kHz'],
    });
  });
});
