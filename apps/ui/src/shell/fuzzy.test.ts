import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches a subsequence case-insensitively and reports the matched indices', () => {
    const match = fuzzyMatch('run', 'New Run');
    expect(match).not.toBeNull();
    // r-u-n land on "…Run" (indices 4,5,6 of "new run").
    expect(match!.indices).toEqual([4, 5, 6]);
  });

  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'New Run')).toBeNull();
    // Right letters, wrong order — subsequence, not anagram.
    expect(fuzzyMatch('nur', 'Run')).toBeNull();
  });

  it('treats an empty query as a neutral match of everything', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('scores a word-boundary + consecutive hit above a mid-word one (ranking)', () => {
    // "Boards": "bo" is consecutive AND starts the word. "Rainbow": "bo" is
    // consecutive but buried mid-word and further along — it must score lower.
    const boundary = fuzzyMatch('bo', 'Boards');
    const midWord = fuzzyMatch('bo', 'Rainbow');
    expect(boundary).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(boundary!.score).toBeGreaterThan(midWord!.score);
  });

  it('scores an earlier match above a later one, all else equal', () => {
    const early = fuzzyMatch('ab', 'ab zz ab');
    const late = fuzzyMatch('ab', 'zz zz ab');
    expect(early!.score).toBeGreaterThan(late!.score);
  });
});
