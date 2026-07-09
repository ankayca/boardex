// Checks-table derivation (BIBLE §7.4): pure formatting over MeasurementCheck.
// The expected window has four shapes (§4: min/max/equals/pattern); each renders
// humanely rather than as raw JSON. Units live on `actual` and describe the
// measurement itself, so a numeric window borrows the same unit for display.
import type { MeasurementCheck } from '@boardex/contract';

const formatNumber = (value: number): string => value.toLocaleString('en-US');

const withUnit = (text: string, unit: string | undefined): string =>
  unit ? `${text} ${unit}` : text;

// "90,000 – 110,000 Hz" · "≥ 5 V" · "≤ 3" · "= true" · matches TEMP=\d+…
// An empty window (no fields set) renders as an em dash, never an empty cell.
export function formatExpected(
  expected: MeasurementCheck['expected'],
  unit?: string,
): string {
  const parts: string[] = [];
  const { min, max, equals, pattern } = expected;

  if (min !== undefined && max !== undefined) {
    parts.push(withUnit(`${formatNumber(min)} – ${formatNumber(max)}`, unit));
  } else if (min !== undefined) {
    parts.push(withUnit(`≥ ${formatNumber(min)}`, unit));
  } else if (max !== undefined) {
    parts.push(withUnit(`≤ ${formatNumber(max)}`, unit));
  }

  if (equals !== undefined) {
    parts.push(`= ${typeof equals === 'string' ? `“${equals}”` : String(equals)}`);
  }
  if (pattern !== undefined) {
    parts.push(`matches ${pattern}`);
  }

  return parts.length > 0 ? parts.join(' and ') : '—';
}

// The measured value with its unit: "99,600 Hz" · "true" · free-form strings as-is.
export function formatActual(actual: MeasurementCheck['actual']): string {
  const { value, unit } = actual;
  const text = typeof value === 'number' ? formatNumber(value) : String(value);
  return withUnit(text, unit);
}
