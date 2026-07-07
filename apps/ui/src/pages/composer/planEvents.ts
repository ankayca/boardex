// The plan's risk summary line (BIBLE §7.2) rides only on the run.plan_generated
// event (§5.2) — RunView (§5.4) carries the plan itself but not the summary, so it
// is read straight off the store's ordered event list. Pure; latest wins if a run
// ever re-plans.
import type { Event } from '@boardex/contract';

export function planRiskSummary(events: readonly Event[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'run.plan_generated') return event.payload.riskSummary;
  }
  return null;
}
