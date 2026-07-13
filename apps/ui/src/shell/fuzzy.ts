// Fuzzy subsequence matcher for the command palette (T6.4). Hand-rolled, not a
// dependency: the need is a single ranked subsequence match over short labels
// (nav items, run titles, board names) — a scoring pass a few lines long, where a
// library (fuse.js et al.) would be kilobytes of index machinery for a list that
// never exceeds a handful of entries. No silent dependency; this earns its keep.
//
// A query matches a text when its characters appear in order (case-insensitively)
// as a subsequence. The score rewards the matches a human reads as "closer": runs
// of consecutive characters and matches that land on a word boundary, lightly
// penalised by how far into the text the match sits. Higher is better.

export interface FuzzyMatch {
  score: number;
  /** Indices into `text` that the query matched, for highlight rendering. */
  indices: number[];
}

const CONSECUTIVE_BONUS = 3;
const BOUNDARY_BONUS = 2;
const BASE = 1;
// A gentle earliness tiebreaker — never enough to overturn a boundary/consecutive
// win, only to order otherwise-equal matches by position.
const DISTANCE_PENALTY = 0.01;

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  // A separator immediately before the match: space, underscore, hyphen, slash,
  // or any non-alphanumeric — the start of a new "word" a human would target.
  return /[^a-z0-9]/i.test(text.charAt(index - 1));
}

/**
 * Score `text` against `query`, or return null when the query is not a subsequence.
 * An empty query matches everything with a neutral score (the palette's default,
 * unfiltered listing), so callers can treat "no query" and "matched" uniformly.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().trim();
  if (q === '') return { score: 0, indices: [] };
  const t = text.toLowerCase();

  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let prev = -2;

  for (const ch of q) {
    let found = -1;
    for (; cursor < t.length; cursor++) {
      if (t.charAt(cursor) === ch) {
        found = cursor;
        cursor++;
        break;
      }
    }
    if (found === -1) return null;

    let charScore = BASE;
    if (found === prev + 1) charScore += CONSECUTIVE_BONUS;
    if (isBoundary(t, found)) charScore += BOUNDARY_BONUS;
    charScore -= found * DISTANCE_PENALTY;

    score += charScore;
    indices.push(found);
    prev = found;
  }

  return { score, indices };
}
