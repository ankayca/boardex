// Plan-gate checklist derivation (Sprint 7 P0, §7.2): the visible safety-gate
// state — a live progress line above the checklist and the Approve button's
// dynamic copy — derived from one confirmed/total pair so the line, the button,
// and the gate can never disagree.

export function checklistProgressLine(confirmed: number, total: number): string {
  return `${confirmed} of ${total} bench connections confirmed`;
}

/**
 * The Approve button's label: while the checklist gates it, the disabled button
 * says WHY it is disabled ("Approve Plan · 2/6 confirmed"); at completion — or
 * with no checklist to confirm — it is plainly "Approve Plan".
 */
export function approvePlanLabel(confirmed: number, total: number): string {
  return total > 0 && confirmed < total
    ? `Approve Plan · ${confirmed}/${total} confirmed`
    : 'Approve Plan';
}
