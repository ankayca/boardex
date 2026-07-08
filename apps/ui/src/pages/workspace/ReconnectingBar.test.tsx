// The amber reconnecting bar (BIBLE §7.3): visible only while the WS is reconnecting,
// absent for every other connection state, so it appears on a drop and clears on resume.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WsConnectionStatus } from '../../lib/ws';
import { ReconnectingBar } from './ReconnectingBar';

describe('ReconnectingBar', () => {
  it('shows the bar while reconnecting', () => {
    render(<ReconnectingBar status="reconnecting" />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to the runner…');
  });

  it('renders nothing when connecting, open, or closed', () => {
    for (const status of ['connecting', 'open', 'closed'] as WsConnectionStatus[]) {
      const { container } = render(<ReconnectingBar status={status} />);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    }
  });
});
