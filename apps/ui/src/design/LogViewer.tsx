import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const LINE_HEIGHT_PX = 20;
// How close (px) to the bottom edge still counts as "at the bottom" for auto-follow.
const FOLLOW_THRESHOLD_PX = LINE_HEIGHT_PX;

export interface LogViewerProps {
  lines: readonly string[];
  /**
   * Per-line timestamp strings (HH:MM:SS or any short token), parallel to `lines`.
   * When provided, a "Timestamps" toggle appears in the pane header; toggling it on
   * renders the column as a dimmed monospace gutter (T6.2). Omit where no per-line
   * time exists (e.g. an artifact's raw text).
   */
  timestamps?: readonly string[];
  /** Viewport cap in px — the pane sizes to its content up to this (T6.1b). */
  maxHeightPx?: number;
  /** Floor in px so a one-line log still reads as a pane, not a sliver. */
  minHeightPx?: number;
  /** Accessible name for the log region. */
  label?: string;
}

// Content padding (py-1) around the virtualized rows, included in the fit height.
const VERTICAL_PADDING_PX = 8;

// The line indices whose text contains the query (case-insensitive). Empty query →
// no matches. Client-side over the loaded array only (T6.2) — no fetch, no regex
// surface for the user.
function findMatches(lines: readonly string[], query: string): number[] {
  if (query === '') return [];
  const needle = query.toLowerCase();
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.toLowerCase().includes(needle)) hits.push(i);
  }
  return hits;
}

// Split one line into text/match segments for highlighting. Case-insensitive,
// non-overlapping, left to right.
function segmentLine(line: string, query: string): { text: string; match: boolean }[] {
  if (query === '') return [{ text: line, match: false }];
  const needle = query.toLowerCase();
  const haystack = line.toLowerCase();
  const segments: { text: string; match: boolean }[] = [];
  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) {
      if (cursor < line.length) segments.push({ text: line.slice(cursor), match: false });
      break;
    }
    if (at > cursor) segments.push({ text: line.slice(cursor, at), match: false });
    segments.push({ text: line.slice(at, at + query.length), match: true });
    cursor = at + query.length;
  }
  return segments;
}

/**
 * Virtualized monospace log pane (BIBLE §6.2). Sizes to its content between
 * minHeightPx and maxHeightPx; follows the tail while the user is at the bottom;
 * scrolling up pauses follow and reveals a "Jump to latest" control. A slim header
 * (present once there is output) offers find-in-log and, when timestamps are
 * supplied, the timestamp-column toggle (T6.2).
 */
export function LogViewer({
  lines,
  timestamps,
  maxHeightPx = 320,
  minHeightPx = 96,
  label = 'Log output',
}: LogViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const [showTimestamps, setShowTimestamps] = useState(false);
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

  const matches = useMemo(() => findMatches(lines, query), [lines, query]);
  const searching = query !== '';
  // A live query pins the viewport to the match under inspection: auto-follow would
  // otherwise yank it to the tail the moment a new line arrives.
  const activeLineIndex = matches.length > 0 ? matches[Math.min(activeMatch, matches.length - 1)]! : -1;

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (follow && !searching) {
      scrollToBottom();
    }
  }, [follow, searching, lines.length, scrollToBottom]);

  // Clamp the active match and bring it into view whenever the match set or the
  // selection changes.
  useEffect(() => {
    if (activeLineIndex >= 0) {
      virtualizer.scrollToIndex(activeLineIndex, { align: 'center' });
    }
  }, [activeLineIndex, virtualizer]);

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

  const changeQuery = (next: string) => {
    setQuery(next);
    setActiveMatch(0);
  };

  const cycleMatch = () => {
    if (matches.length > 0) setActiveMatch((current) => (current + 1) % matches.length);
  };

  const onFindKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      cycleMatch();
    } else if (event.key === 'Escape' && query !== '') {
      // Esc convention (§6.2 v2.3): a consuming handler stops propagation so
      // only the topmost surface closes — clearing an active find must not
      // also dismiss the Drawer hosting it. An EMPTY find lets Esc bubble.
      event.preventDefault();
      event.stopPropagation();
      changeQuery('');
    }
  };

  return (
    <div className="overflow-hidden rounded-control border border-border bg-surface">
      {lines.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              onKeyDown={onFindKeyDown}
              placeholder="Find in log…"
              aria-label={`Find in ${label}`}
              className="min-w-0 flex-1 rounded-control border border-border bg-canvas px-2 py-1 font-mono text-meta text-text-primary placeholder:font-sans placeholder:text-text-secondary focus:border-accent focus:outline-none"
            />
            {searching && (
              <>
                <span role="status" className="shrink-0 text-meta text-text-secondary">
                  {matches.length === 0
                    ? 'No matches'
                    : `${Math.min(activeMatch, matches.length - 1) + 1}/${matches.length}`}
                </span>
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => changeQuery('')}
                  className="shrink-0 rounded-control p-1 text-text-secondary transition-colors duration-fast ease-motion hover:text-text-primary"
                >
                  <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none">
                    <path
                      d="M3.5 3.5l7 7M10.5 3.5l-7 7"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </>
            )}
          </div>
          {timestamps && (
            <button
              type="button"
              aria-pressed={showTimestamps}
              onClick={() => setShowTimestamps((current) => !current)}
              className={`shrink-0 rounded-control border px-2 py-1 text-metadata font-medium uppercase transition-colors duration-fast ease-motion ${
                showTimestamps
                  ? 'border-accent text-accent'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              Timestamps
            </button>
          )}
        </div>
      )}
      <div className="relative overflow-hidden">
        <div
          ref={scrollRef}
          role="log"
          aria-label={label}
          // §6.2 v2.3: run-state changes and approvals are announced (the rail's
          // live region) — streamed log lines are NOT. role="log" implies polite
          // announcements by default; off silences the per-line chatter.
          aria-live="off"
          onScroll={handleScroll}
          className="overflow-auto py-1 font-mono text-meta text-text-primary"
          style={{ height }}
        >
          {lines.length === 0 ? (
            <p className="px-3 py-2 font-sans text-meta text-text-secondary">No output yet.</p>
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const isActiveMatch = item.index === activeLineIndex;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    className="absolute left-0 top-0 flex w-full whitespace-pre px-3"
                    style={{
                      height: item.size,
                      lineHeight: `${LINE_HEIGHT_PX}px`,
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    {showTimestamps && timestamps && (
                      <span className="mr-3 shrink-0 select-none text-text-secondary">
                        {timestamps[item.index] ?? ''}
                      </span>
                    )}
                    <span className="min-w-0">
                      {searching
                        ? segmentLine(lines[item.index]!, query).map((segment, i) =>
                            segment.match ? (
                              <mark
                                key={i}
                                className={`rounded-[3px] ${
                                  isActiveMatch
                                    ? 'bg-accent text-white'
                                    : 'bg-neutral-badge-bg text-text-primary ring-1 ring-inset ring-border-strong'
                                }`}
                              >
                                {segment.text}
                              </mark>
                            ) : (
                              <span key={i}>{segment.text}</span>
                            ),
                          )
                        : lines[item.index]}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!follow && !searching && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 right-3 rounded-control border border-border bg-surface px-3 py-1 text-meta font-medium text-accent shadow-raised transition-colors duration-fast ease-motion hover:text-accent-hover"
          >
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
