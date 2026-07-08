// Hypothesis ranking for the Diagnosis Card (BIBLE §7.3): most-confident first.
import type { Diagnosis, HypothesisConfidence } from '@boardex/contract';

const CONFIDENCE_RANK: Record<HypothesisConfidence, number> = { high: 0, moderate: 1, low: 2 };

/** Hypotheses ranked most-confident first; stable within a confidence tier. */
export function rankHypotheses(hypotheses: Diagnosis['hypotheses']): Diagnosis['hypotheses'] {
  return [...hypotheses].sort(
    (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
  );
}
