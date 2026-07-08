import { describe, expect, it } from 'vitest';
import { repoBasename } from './repoBasename';

describe('repoBasename', () => {
  it('returns the last path segment', () => {
    expect(repoBasename('/bench/firmware/bme280-f303re')).toBe('bme280-f303re');
    expect(repoBasename('relative/path/repo')).toBe('repo');
  });

  it('ignores trailing slashes, single or repeated', () => {
    expect(repoBasename('/bench/firmware/bme280-f303re/')).toBe('bme280-f303re');
    expect(repoBasename('/bench/firmware/bme280-f303re///')).toBe('bme280-f303re');
  });

  it('returns a segmentless path unchanged', () => {
    expect(repoBasename('repo')).toBe('repo');
    expect(repoBasename('/')).toBe('/');
    expect(repoBasename('')).toBe('');
  });
});
