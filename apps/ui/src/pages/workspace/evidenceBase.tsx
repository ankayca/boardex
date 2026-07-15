// The run-surface base path for evidence deep links (T6.5). Workspace surfaces —
// the evidence band, the approval/diagnosis cards, the checks table — build their
// evidence and report hrefs relative to this base. With no provider (the live app)
// it defaults to `/runs/${runId}`, so every existing link and its test are unchanged;
// the demo shell provides `/demo`, so the same reused surfaces deep-link within the
// demo instead of navigating to a live run route.
import { createContext, useContext, type ReactNode } from 'react';

const EvidenceBaseContext = createContext<string | null>(null);

export function EvidenceBaseProvider({ base, children }: { base: string; children: ReactNode }) {
  return <EvidenceBaseContext.Provider value={base}>{children}</EvidenceBaseContext.Provider>;
}

export function useEvidenceBase(runId: string): string {
  return useContext(EvidenceBaseContext) ?? `/runs/${runId}`;
}
