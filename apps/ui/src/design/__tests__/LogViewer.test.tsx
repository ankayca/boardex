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
    // T6.1b: `height` became `maxHeightPx` — the pane sizes to content up to the cap.
    render(<LogViewer lines={makeLines(1000)} maxHeightPx={200} label="Build log" />);
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

  // P1 #7: a streaming log labels the paused-scroll control "Resume live" and,
  // on click, rejoins the tail so new lines auto-scroll again.
  it('streaming: "Resume live" appears on scroll-up and returns to tail-follow', () => {
    const { rerender } = render(<LogViewer lines={makeLines(50)} streaming />);
    const log = screen.getByRole('log');
    mockScrollMetrics(log, 1000, 200);
    // At the bottom: no chip. Scroll up during streaming: the chip appears, named
    // for the live tail (not "Jump to latest").
    expect(screen.queryByRole('button', { name: 'Resume live' })).not.toBeInTheDocument();
    fireEvent.scroll(log, { target: { scrollTop: 100 } });
    expect(screen.getByRole('button', { name: 'Resume live' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    // Click returns to the tail...
    fireEvent.click(screen.getByRole('button', { name: 'Resume live' }));
    expect(log.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'Resume live' })).not.toBeInTheDocument();
    // ...and follow resumes: a new line auto-scrolls without another click.
    mockScrollMetrics(log, 1200, 200);
    rerender(<LogViewer lines={makeLines(60)} streaming />);
    expect(log.scrollTop).toBe(1200);
  });

  it('shows a placeholder and no header when there are no lines', () => {
    render(<LogViewer lines={[]} label="Empty" />);
    expect(screen.getByText('No output yet.')).toBeInTheDocument();
    // The find/timestamp header only exists once there is output.
    expect(screen.queryByRole('textbox', { name: /Find in/ })).not.toBeInTheDocument();
  });

  it('find-in-log reports the match count, highlights, and Escape clears it', () => {
    render(<LogViewer lines={makeLines(50)} label="Findable" />);
    const find = screen.getByRole('textbox', { name: 'Find in Findable' });
    fireEvent.change(find, { target: { value: 'line 0' } });
    // Exactly one line ("line 0") contains "line 0" — "line 10".."line 49" do not.
    expect(screen.getByRole('status')).toHaveTextContent('1/1');
    expect(screen.getByText('line 0', { selector: 'mark' })).toBeInTheDocument();
    fireEvent.keyDown(find, { key: 'Escape' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('line 0', { selector: 'mark' })).not.toBeInTheDocument();
    expect((find as HTMLInputElement).value).toBe('');
  });

  it('shows a clear (✕) button while searching that empties the query', () => {
    render(<LogViewer lines={makeLines(50)} label="Clearable" />);
    const find = screen.getByRole('textbox', { name: 'Find in Clearable' });
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    fireEvent.change(find, { target: { value: 'line 2' } });
    const clear = screen.getByRole('button', { name: 'Clear search' });
    fireEvent.click(clear);
    expect((find as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });

  it('find-in-log cycles matches on Enter and shows "No matches" when none', () => {
    render(<LogViewer lines={makeLines(50)} label="Cyclable" />);
    const find = screen.getByRole('textbox', { name: 'Find in Cyclable' });
    fireEvent.change(find, { target: { value: 'line' } }); // every line matches
    expect(screen.getByRole('status')).toHaveTextContent('1/50');
    fireEvent.keyDown(find, { key: 'Enter' });
    expect(screen.getByRole('status')).toHaveTextContent('2/50');
    fireEvent.change(find, { target: { value: 'zzz' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matches');
  });

  it('offers a timestamp toggle only when timestamps are supplied, and renders them when on', () => {
    const lines = makeLines(3);
    const timestamps = ['14:03:22', '14:03:23', '14:03:24'];
    const { rerender } = render(<LogViewer lines={lines} label="Timed" />);
    expect(screen.queryByRole('button', { name: 'Timestamps' })).not.toBeInTheDocument();

    rerender(<LogViewer lines={lines} timestamps={timestamps} label="Timed" />);
    const toggle = screen.getByRole('button', { name: 'Timestamps' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('14:03:22')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('14:03:22')).toBeInTheDocument();
  });

  // T6.1b: the pane sizes to its content — floor 96px, cap 320px by default.
  it('sizes to content between the floor and the cap', () => {
    const { rerender } = render(<LogViewer lines={makeLines(3)} label="Sized log" />);
    const log = screen.getByRole('log', { name: 'Sized log' });
    expect(log.style.height).toBe('96px'); // 3 lines fit under the floor
    rerender(<LogViewer lines={makeLines(10)} label="Sized log" />);
    expect(log.style.height).toBe('208px'); // 10 × 20px + 8px padding
    rerender(<LogViewer lines={makeLines(1000)} label="Sized log" />);
    expect(log.style.height).toBe('320px'); // capped
  });
});
