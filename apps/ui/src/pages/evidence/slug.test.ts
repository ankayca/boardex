import { describe, expect, it } from 'vitest';
import { slugify } from './slug';

describe('slugify (GitHub-style heading slugs, T6.3)', () => {
  it('slugs the mock datasheet headings to the exact fixture locators', () => {
    // These two must round-trip: the fixtures cite these locators, the mock authors
    // headings that slugify to them, and the Sources tab matches on the slug.
    expect(slugify('I2C device addressing')).toBe('i2c-device-addressing');
    expect(slugify('Timing specifications')).toBe('timing-specifications');
  });

  it('lowercases, drops punctuation, and collapses whitespace to single hyphens', () => {
    expect(slugify('§5.4.1  Addressing (details)')).toBe('541-addressing-details');
    expect(slugify('  Trailing & leading  ')).toBe('trailing-leading');
    expect(slugify('Keeps_underscores and 0x76 digits')).toBe('keeps_underscores-and-0x76-digits');
  });
});
