// Compact relative timestamp for the "updated-at" column of a run row (BIBLE §7.1).
// Pure — `now` is injected (defaults to Date.now()) so it is deterministically testable.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = now - then;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  // Older than a week: an absolute date reads better than "37d ago".
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
