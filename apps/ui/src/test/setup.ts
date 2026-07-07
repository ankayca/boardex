import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// RTL auto-cleanup relies on injected globals, which we keep off — clean up explicitly.
afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver; @tanstack/react-virtual requires one to observe the
// scroll element. A no-op keeps the virtualizer on its initialRect in tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
