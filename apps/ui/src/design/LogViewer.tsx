import { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const LINE_HEIGHT_PX = 20;
// How close (px) to the bottom edge still counts as "at the bottom" for auto-follow.
const FOLLOW_THRESHOLD_PX = LINE_HEIGHT_PX;

export interface LogViewerProps {
  lines: readonly string[];
  /** Viewport cap in px — the pane sizes to its content up to this (T6.1b). */
  maxHeightPx?: number;
  /** Floor in px so a one-line log still reads as a pane, not a sliver. */
  minHeightPx?: number;
  /** Accessible name for the log region. */
  label?: string;
}

// Content padding (py-1) around the virtualized rows, included in the fit height.
const VERTICAL_PADDING_PX = 8;

/**
 * Virtualized monospace log pane (BIBLE §6.2). Sizes to its content between
 * minHeightPx and maxHeightPx; follows the tail while the user is at the
 * bottom; scrolling up pauses follow and reveals a "Jump to latest" control.
 */
export function LogViewer({
  lines,
  maxHeightPx = 320,
  minHeightPx = 96,
  label = 'Log output',
}: LogViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const height = Math.min(
    maxHeightPx,
    Math.max(minHeightPx, lines.length * LINE_HEIGHT_PX + VERTICAL_PADDING_PX),
  );

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT_PX,
    overscan: 10,
    initialRect: { width: 640, height },
  });

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (follow) {
      scrollToBottom();
    }
  }, [follow, lines.length, scrollToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollow(distanceFromBottom <= FOLLOW_THRESHOLD_PX);
  };

  const jumpToLatest = () => {
    scrollToBottom();
    setFollow(true);
  };

  return (
    <div className="relative overflow-hidden rounded-button border border-border bg-bg-panel">
      <div
        ref={scrollRef}
        role="log"
        aria-label={label}
        onScroll={handleScroll}
        className="overflow-auto py-1 font-mono text-meta text-text-primary"
        style={{ height }}
      >
        {lines.length === 0 ? (
          <p className="px-3 py-2 font-sans text-meta text-text-secondary">No output yet.</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                className="absolute left-0 top-0 w-full whitespace-pre px-3"
                style={{
                  height: item.size,
                  lineHeight: `${LINE_HEIGHT_PX}px`,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {lines[item.index]}
              </div>
            ))}
          </div>
        )}
      </div>
      {!follow && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 right-3 rounded-button border border-border bg-bg-panel px-3 py-1 text-meta font-medium text-accent shadow-raised transition-colors duration-fast ease-motion hover:text-accent-hover"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
