// Route placeholders. Each is replaced by its real screen in a later sprint — Board
// Profile screens (Sprint 4). Home is live in pages/home (T1.2), the composer in
// pages/composer (T1.3). See docs/BIBLE.md §7-8.
import { useParams } from 'react-router-dom';

function Placeholder({ title, sprint }: { title: string; sprint: string }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-page font-semibold text-text-primary">{title}</h1>
      <p className="mt-2 text-body text-text-secondary">Built in {sprint}.</p>
    </main>
  );
}

export function BoardsPage() {
  return <Placeholder title="Board Profiles" sprint="Sprint 4" />;
}

// The evidence surface (Evidence Detail, §7.4) is Sprint 3. The route exists now so
// the Run Workspace's real deep links — evidence-band chips and Open Logs/Diff/Report,
// plus the Diagnosis Card's stub links — resolve to a clean page instead of a 404.
export function EvidencePage() {
  return <Placeholder title="Evidence" sprint="Sprint 3" />;
}

export function BoardDetailPage() {
  const { id } = useParams();
  return <Placeholder title={`Board ${id ?? ''}`.trim()} sprint="Sprint 4" />;
}
