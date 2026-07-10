import { describe, expect, it } from 'vitest';
import { saveErrorMessage } from './saveError';

describe('saveErrorMessage', () => {
  it('reads a 409 as a stale-edit conflict and tells the user to reload first', () => {
    expect(saveErrorMessage(Object.assign(new Error('conflict'), { status: 409 }))).toMatch(
      /changed on the runner/,
    );
  });

  it('reads any other failure — including a bare network error — as "could not save"', () => {
    expect(saveErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Could not save/);
    expect(saveErrorMessage(Object.assign(new Error('boom'), { status: 500 }))).toMatch(
      /Could not save/,
    );
    expect(saveErrorMessage(null)).toMatch(/Could not save/);
  });
});
