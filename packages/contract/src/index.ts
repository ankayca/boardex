// @boardex/contract — the single source of truth for the Boardex event stream and
// command API (BIBLE §4-5). Zod schemas, inferred TS types, and the pure reducer land
// in T0.2; the BME280 fixture lands in T0.3. This scaffold exposes only the contract
// version so downstream packages can link against it.
export const CONTRACT_VERSION = 'boardex-contract/0.1' as const;
