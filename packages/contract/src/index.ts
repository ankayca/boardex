// @boardex/contract — the single source of truth for the Boardex event stream and
// command API (BIBLE §4-5): Zod schemas, inferred TS types, and the pure reducer.
// The BME280 fixture lands in T0.3.
export const CONTRACT_VERSION = 'boardex-contract/0.1' as const;

export * from './entities';
export * from './events';
export * from './commands';
export * from './artifacts';
export * from './reducer';
