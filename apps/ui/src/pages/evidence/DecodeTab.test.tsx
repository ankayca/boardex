// Protocol Decode tab density (§7.4, Sprint 7 P1 #6): the annotation column
// clamps to two lines and expands in place on click. Content is stubbed at the
// api seam (the shared T3.1 pattern); the fold/row derivation itself is unit-
// tested in decode.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { artifactOf } from '../workspace/test-events';
import { api } from '../../lib/api';
import { DecodeTab } from './DecodeTab';

const DECODE_JSON = JSON.stringify({
  protocol: 'i2c',
  sample_rate_hz: 4_000_000,
  annotations: [
    { raw: 'START', text: 'START', start: 400_000 },
    { raw: 'ADDRESS WRITE: 76 ACK', text: 'ADDRESS WRITE: 76 ACK' },
    { raw: 'DATA WRITE: D0 ACK', text: 'DATA WRITE: D0 ACK' },
    { raw: 'STOP', text: 'STOP' },
  ],
  transactions: [{ addr_7bit: 118, rw: 'w', write: [0xd0], read: [], nack_at: null }],
});

function renderDecode() {
  vi.spyOn(api, 'getArtifactText').mockResolvedValue(DECODE_JSON);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DecodeTab artifact={artifactOf('art_decode', 'protocol_decode')} scrollToFailure={false} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('DecodeTab annotation clamp/expand (P1 #6)', () => {
  it('clamps the annotation to two lines and expands it in place on click', async () => {
    const user = userEvent.setup();
    renderDecode();

    const annotation = await screen.findByRole('button', { name: /ADDRESS WRITE: 76 ACK/ });
    // Resting: clamped to two lines and collapsed. The clamp rides line-clamp-2's
    // own -webkit-box display, so the collapsed cell must NOT carry a display-
    // overriding class — a `block` alongside line-clamp-2 defeats the clamp.
    expect(annotation).toHaveClass('line-clamp-2');
    expect(annotation).not.toHaveClass('block');
    expect(annotation).toHaveAttribute('aria-expanded', 'false');

    await user.click(annotation);
    // Expanded: the clamp is gone and the cell falls back to a plain block display.
    expect(annotation).not.toHaveClass('line-clamp-2');
    expect(annotation).toHaveClass('block');
    expect(annotation).toHaveAttribute('aria-expanded', 'true');
  });
});
