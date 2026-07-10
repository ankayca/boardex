// POST /board-profiles failures, phrased for a human (BIBLE §5.3 house pattern: a 409
// is a state-refresh signal, not a crash; everything else is "the runner didn't take
// it"). Reads the status structurally rather than through `instanceof ApiError` so the
// message survives a mocked api module.
export function saveErrorMessage(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 409) {
    return 'This profile changed on the runner while you were editing. Reload the profile, re-apply your changes, then save again.';
  }
  return 'Could not save the profile — check that the runner is online, then try again.';
}
