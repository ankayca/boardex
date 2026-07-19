// Raw artifacts tab Download-all (§7.4, Sprint 7 P1 #8): per-artifact failures
// accumulate independently — a later artifact succeeding must NOT clear an
// earlier artifact's failure marker. Content is stubbed at the api seam (the
// shared T3.1 pattern); the filename/grouping derivation is unit-tested in
// raw.test.ts.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../lib/api';
import { artifactOf, envelope, run, viewFrom } from '../workspace/test-events';
import { RawTab } from './RawTab';

beforeAll(() => {
  // jsdom has no object-URL support; the successful saves' Blob path needs it not to throw.
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
});

afterEach(() => vi.restoreAllMocks());

// Three artifacts in one run-level group (no steps → no iteration headers).
const threeArtifactView = () =>
  viewFrom([
    envelope(1, 'run.created', { run }),
    envelope(2, 'artifact.created', { artifact: artifactOf('art_a', 'build_log') }),
    envelope(3, 'artifact.created', { artifact: artifactOf('art_b', 'serial_log') }),
    envelope(4, 'artifact.created', { artifact: artifactOf('art_c', 'code_diff') }),
  ]);

describe('RawTab Download-all failure accumulation (P1 #8)', () => {
  it('marks exactly the one row that failed, even when a later download succeeds', async () => {
    const user = userEvent.setup();
    const getBlob = vi
      .spyOn(api, 'getArtifactBlob')
      .mockImplementation((id: string) =>
        id === 'art_b' ? Promise.reject(new Error('boom')) : Promise.resolve(new Blob(['x'])),
      );

    render(<RawTab view={threeArtifactView()} highlightArtifactId={null} />);

    await user.click(screen.getByRole('button', { name: 'Download all' }));

    // All three are attempted in turn — art_c succeeds AFTER art_b failed.
    await waitFor(() => expect(getBlob).toHaveBeenCalledTimes(3));

    // Exactly one failure marker survives, on art_b's row — art_c's later success
    // did not clear it. getByRole throws unless there is exactly one alert.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').closest('tr')).toHaveTextContent('art_b');
  });
});
