// Raw-artifacts helpers (§7.4): kind-derived download filenames, humanized
// sizes, and the download path carrying the artifact's own MIME type.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, ArtifactKind, RunView } from '@boardex/contract';
import { artifactOf } from '../workspace/test-events';
import {
  downloadArtifact,
  downloadFilename,
  groupArtifacts,
  humanizeSize,
  saveBlobViaAnchor,
} from './raw';

describe('downloadFilename', () => {
  it('derives id + kind extension for every artifact kind', () => {
    const cases: [ArtifactKind, string][] = [
      ['serial_log', 'art_x.log'],
      ['build_log', 'art_x.log'],
      ['flash_log', 'art_x.log'],
      ['logic_capture', 'art_x.sr'],
      ['protocol_decode', 'art_x.json'],
      ['code_diff', 'art_x.json'],
      ['timing_measurement', 'art_x.json'],
      ['report_md', 'art_x.md'],
    ];
    for (const [kind, expected] of cases) {
      expect(downloadFilename({ id: 'art_x', kind })).toBe(expected);
    }
  });
});

describe('humanizeSize', () => {
  it('formats bytes, KB, and MB', () => {
    expect(humanizeSize(76)).toBe('76 B');
    expect(humanizeSize(1024)).toBe('1.0 KB');
    expect(humanizeSize(10923)).toBe('10.7 KB');
    expect(humanizeSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('groupArtifacts (P1 #8)', () => {
  it('groups by iteration (ascending, null last) then orders each group by type', () => {
    const view = {
      steps: [{ id: 'st_a' }, { id: 'st_b' }],
      iterations: [{ iteration: 2, reason: 'fix', firstStepIndex: 1 }],
      artifacts: [
        { ...artifactOf('a_diff', 'code_diff'), stepId: 'st_a' },
        { ...artifactOf('a_build', 'build_log'), stepId: 'st_a' },
        { ...artifactOf('a_serial2', 'serial_log'), stepId: 'st_b' },
        // step not in the view → iteration unresolvable → trailing null group.
        { ...artifactOf('a_report', 'report_md'), stepId: 'st_missing' },
      ],
    } as unknown as RunView;

    const groups = groupArtifacts(view);
    expect(groups.map((g) => g.iteration)).toEqual([1, 2, null]);
    // Iteration 1: build_log sorts before code_diff (pipeline KIND_ORDER).
    expect(groups[0]!.artifacts.map((a) => a.id)).toEqual(['a_build', 'a_diff']);
    expect(groups[1]!.artifacts.map((a) => a.id)).toEqual(['a_serial2']);
    expect(groups[2]!.artifacts.map((a) => a.id)).toEqual(['a_report']);
  });
});

describe('downloadArtifact', () => {
  it('fetches by id with the artifact MIME and saves under the derived filename', async () => {
    const artifact: Artifact = {
      ...artifactOf('art_capture', 'logic_capture'),
      mimeType: 'application/octet-stream',
    };
    const blob = new Blob(['raw'], { type: artifact.mimeType });
    const getBlob = vi.fn().mockResolvedValue(blob);
    const save = vi.fn();

    await downloadArtifact(artifact, getBlob, save);

    expect(getBlob).toHaveBeenCalledWith('art_capture', 'application/octet-stream');
    expect(save).toHaveBeenCalledWith(blob, 'art_capture.sr');
  });

  it('propagates fetch failures to the caller (the tab renders the error)', async () => {
    const artifact = artifactOf('art_capture', 'logic_capture');
    const getBlob = vi.fn().mockRejectedValue(new Error('down'));
    const save = vi.fn();
    await expect(downloadArtifact(artifact, getBlob, save)).rejects.toThrow('down');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('saveBlobViaAnchor', () => {
  // jsdom's URL implements neither object-URL method; stub both and clean up.
  const urlWithObjectUrls = URL as unknown as {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };

  afterEach(() => {
    delete urlWithObjectUrls.createObjectURL;
    delete urlWithObjectUrls.revokeObjectURL;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('clicks an anchor attached to the document and defers the object-URL revoke (Safari)', () => {
    vi.useFakeTimers();
    const createSpy = vi.fn(() => 'blob:mock');
    const revokeSpy = vi.fn();
    urlWithObjectUrls.createObjectURL = createSpy;
    urlWithObjectUrls.revokeObjectURL = revokeSpy;
    let clickedWhileAttached = false;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedWhileAttached = this.isConnected;
      });

    saveBlobViaAnchor(new Blob(['raw']), 'art_capture.sr');

    expect(createSpy).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(clickedWhileAttached).toBe(true);
    // The anchor is cleaned up, but the URL outlives the click…
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeSpy).not.toHaveBeenCalled();
    // …until the deferred revoke runs.
    vi.runAllTimers();
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock');
  });
});
