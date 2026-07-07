import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LogViewer } from '../LogViewer';

const makeLines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`);

// jsdom reports zero offset sizes, so the virtualizer would render no rows at all
// (virtual-core measures the scroll element via offsetWidth/offsetHeight). Give
// every element a 640x200 box; the virtualizer then windows against 200px.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 200,
  });
});

// jsdom reports zero scroll metrics; give the scroll container a real geometry so
// the follow math (scrollHeight - scrollTop - clientHeight) is exercised.
function mockScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
}

describe('LogViewer', () => {
  it('renders a monospace log region with only a virtualized window of lines', () => {
    render(<LogViewer lines={makeLines(1000)} height={200} label="Build log" />);
    const log = screen.getByRole('log', { name: 'Build log' });
    expect(log).toHaveClass('font-mono');
    expect(screen.getByText('line 0')).toBeInTheDocument();
    expect(screen.queryByText('line 999')).not.toBeInTheDocument();
  });

  it('auto-follows: scrolls to the bottom when new lines arrive', () => {
    const { rerender } = render(<LogViewer lines={makeLines(50)} />);
    const log = screen.getByRole('log');
    mockScrollMetrics(log, 1000, 200);
    rerender(<LogViewer lines={makeLines(60)} />);
    expect(log.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('pauses follow on scroll-up and stops yanking to the bottom', () => {
    const { rerender } = render(<LogViewer lines={makeLines(50)} />);
    const log = screen.getByRole('log');
    mockScrollMetrics(log, 1000, 200);
    fireEvent.scroll(log, { target: { scrollTop: 100 } });
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
    rerender(<LogViewer lines={makeLines(80)} />);
    expect(log.scrollTop).toBe(100);
  });

  it('resumes follow when scrolled back to the bottom', () => {
    const { rerender } = render(<LogViewer lines={makeLines(50)} />);
    const log = screen.getByRole('log');
    mockScrollMetrics(log, 1000, 200);
    fireEvent.scroll(log, { target: { scrollTop: 100 } });
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
    fireEvent.scroll(log, { target: { scrollTop: 800 } });
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    rerender(<LogViewer lines={makeLines(60)} />);
    expect(log.scrollTop).toBe(1000);
  });

  it('"Jump to latest" scrolls to the newest line and resumes follow', () => {
    render(<LogViewer lines={makeLines(50)} />);
    const log = screen.getByRole('log');
    mockScrollMetrics(log, 1000, 200);
    fireEvent.scroll(log, { target: { scrollTop: 100 } });
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(log.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('shows a placeholder when there are no lines', () => {
    render(<LogViewer lines={[]} />);
    expect(screen.getByText('No output yet.')).toBeInTheDocument();
  });
});
