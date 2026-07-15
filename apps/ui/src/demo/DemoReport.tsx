// The demo's Validation Report screen (T6.5) at /demo/report — the tour's final
// "deliverable" moment. Reuses the report renderer (ReportView) and reads the report
// markdown by reference through the api's demo-source branch (bundled, offline). A
// reduced read of the live ReportPage: no runner, no export chrome — the point is to
// show the report Boardex produces.
import { Link } from 'react-router-dom';
import type { RunView } from '@boardex/contract';
import { useArtifactContent } from '../pages/evidence/ArtifactContent';
import { ReportView } from '../pages/report/ReportView';
import { evidenceTargets } from '../pages/workspace/evidence';

const PAGE = 'mx-auto max-w-3xl px-6 py-8';

function BackLink() {
  return (
    <Link to="/demo" className="text-meta text-accent hover:underline">
      ← Back to run
    </Link>
  );
}

export function DemoReport({ view }: { view: RunView }) {
  const reportId = evidenceTargets(view).report;
  const artifact = reportId ? view.artifacts.find((a) => a.id === reportId) : undefined;
  const content = useArtifactContent(artifact?.id);

  const header = (
    <header className="mb-6">
      <BackLink />
      <h1 className="mt-2 text-page font-semibold text-text-primary">Validation Report</h1>
      <p className="mt-1 text-meta text-text-secondary">{view.run.title}</p>
    </header>
  );

  if (!artifact) {
    return (
      <main className={PAGE}>
        {header}
        <p className="text-body text-text-secondary">
          The report appears here once the demo run completes.
        </p>
      </main>
    );
  }

  return (
    <main className={PAGE}>
      {header}
      {content.isPending && (
        <p role="status" className="text-body text-text-secondary">
          Loading {artifact.label}…
        </p>
      )}
      {content.isSuccess && content.data.trim() !== '' && (
        <ReportView
          markdown={content.data}
          runId={view.run.id}
          artifacts={view.artifacts}
          checks={view.checks}
        />
      )}
    </main>
  );
}
