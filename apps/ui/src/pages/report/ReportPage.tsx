// Validation Report screen (BIBLE §7.6) at /runs/:id/report. Renders the completed
// run's report_md artifact with house styling and offers the two D9 export actions —
// Copy Markdown and Download .md. State comes from the reduced RunView (D5) via the
// run stream, exactly like the workspace; the report's Markdown is fetched by
// reference (D4) and rendered, never regenerated. Every unhappy path fails closed:
// no report artifact (a run.failed with no report is honest, not invented), a fetch
// error (retryable), or empty content each render an explicit state instead of a
// blank or a crash.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Artifact, RunView } from '@boardex/contract';
import { Button, EmptyState } from '../../design';
import { api } from '../../lib/api';
import { useRunView } from '../../lib/runStore';
import { useRunStream } from '../../lib/useRunStream';
import { downloadArtifact, downloadFilename } from '../evidence/raw';
import { useArtifactContent } from '../evidence/ArtifactContent';
import { evidenceTargets } from '../workspace/evidence';
import { coverageLine, deriveDualOutcome, executionLabel } from '../workspace/outcome';
import { reportSummary } from './summary';
import { ReportView } from './ReportView';

// §7.6 / P1 #9: the report reads as a document — an off-white page canvas with the
// centred white report surface (max width in the 820–860 band). The container
// width is shared by the sticky header bar and the body so they align.
const CONTAINER = 'mx-auto w-full max-w-[840px] px-6';
const BODY = `${CONTAINER} py-8`;

// The dual-outcome split in the report header (v2.4, PRESENTATION ONLY — the
// report artifact's markdown is the agent's and is never rewritten): what the
// run did vs what the recorded evidence covers, from the same RunView
// derivation as the status card.
function OutcomeSummary({ view }: { view: RunView }) {
  const outcome = deriveDualOutcome(view);
  if (!outcome) return null;
  return (
    <dl className="mt-2 space-y-0.5 text-meta">
      <div>
        <dt className="inline font-medium text-text-primary">Run execution</dt>
        <dd className="inline text-text-secondary">
          {' — '}
          {executionLabel(outcome)}
          {outcome.execution.reason && ` · ${outcome.execution.reason}`}
        </dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-primary">Validation coverage</dt>
        <dd className="inline text-text-secondary">
          {' — '}
          {coverageLine(outcome.coverage)}
        </dd>
      </div>
    </dl>
  );
}

function BackLink({ runId }: { runId: string }) {
  return (
    <Link to={`/runs/${runId}`} className="text-meta text-accent hover:underline">
      ← Back to run
    </Link>
  );
}

// The document page (P1 #9): off-white canvas, a sticky "Back to run" bar that
// persists down a long report, and the centred white surface below.
function PageShell({ runId, children }: { runId: string; children: ReactNode }) {
  return (
    <main className="min-h-full bg-canvas">
      <div className="sticky top-0 z-10 border-b border-border bg-canvas">
        <div className={`${CONTAINER} flex items-center py-2.5`}>
          <BackLink runId={runId} />
        </div>
      </div>
      <div className={BODY}>{children}</div>
    </main>
  );
}

// The compact metadata row (P1 #9): Run ID · date · iterations. Result and checks
// live in the dual-outcome split (OutcomeSummary) below, where the reason shows.
function SummaryRow({ view }: { view: RunView }) {
  const summary = reportSummary(view);
  const items: ReactNode[] = [
    <span className="font-mono text-text-primary">Run {summary.runId}</span>,
  ];
  if (summary.date) items.push(summary.date);
  items.push(`${summary.iterations} iteration${summary.iterations === 1 ? '' : 's'}`);
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-metadata text-text-secondary">
      {items.map((item, index) => (
        <span key={index} className="inline-flex items-center gap-2">
          {index > 0 && (
            <span aria-hidden="true" className="text-border-strong">
              ·
            </span>
          )}
          <span>{item}</span>
        </span>
      ))}
    </p>
  );
}

// Copy the raw Markdown to the clipboard with transient confirmation feedback. The
// timeout is cleared on unmount so a resolved copy never sets state on a gone page.
function CopyMarkdownButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('error');
    }
    timer.current = setTimeout(() => setState('idle'), 2000);
  };

  return (
    <div className="flex flex-col items-end">
      <Button variant="secondary" onClick={() => void copy()}>
        {state === 'copied' ? 'Copied ✓' : 'Copy Markdown'}
      </Button>
      {state === 'error' && (
        <p role="alert" className="mt-1 text-meta text-warn">
          Couldn’t copy to the clipboard.
        </p>
      )}
      {state === 'copied' && (
        <span role="status" className="sr-only">
          Report Markdown copied to the clipboard.
        </span>
      )}
    </div>
  );
}

// Download the raw artifact under the raw-tab filename convention (art_report.md),
// through the same fetch-then-Blob path as the Raw artifacts tab so the MIME type
// and filename hold regardless of the runner's origin.
function DownloadMarkdownButton({ artifact }: { artifact: Artifact }) {
  const [failed, setFailed] = useState(false);
  const download = async () => {
    setFailed(false);
    try {
      await downloadArtifact(artifact, api.getArtifactBlob);
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="flex flex-col items-end">
      <Button variant="secondary" title={`Download ${downloadFilename(artifact)}`} onClick={() => void download()}>
        Download .md
      </Button>
      {failed && (
        <p role="alert" className="mt-1 text-meta text-warn">
          Download failed — the report could not be fetched.
        </p>
      )}
    </div>
  );
}

export default function ReportPage() {
  const { id = '' } = useParams();
  useRunStream(id);
  const view = useRunView(id);

  const reportId = view ? evidenceTargets(view).report : null;
  const artifact = view && reportId ? view.artifacts.find((a) => a.id === reportId) : undefined;
  const content = useArtifactContent(artifact?.id);

  // The run's profile documents back the report's sourceRef → Sources deep links
  // (T6.3): a sourceRef only resolves when its check's sourceDoc names a real
  // document. Same ['board-profiles'] query key as the composer/workspace.
  const profilesQuery = useQuery({
    queryKey: ['board-profiles'],
    queryFn: () => api.listBoardProfiles(),
  });
  const documents = view
    ? profilesQuery.data?.find((p) => p.id === view.run.boardProfileId)?.documents
    : undefined;

  if (!view) {
    return (
      <PageShell runId={id}>
        <p className="text-body text-text-secondary">Connecting to run…</p>
      </PageShell>
    );
  }

  const { run } = view;

  const header = (
    <header className="mb-6">
      <h1 className="text-page font-semibold text-text-primary">Validation Report</h1>
      <p className="mt-1 text-meta text-text-secondary">{run.title}</p>
      <SummaryRow view={view} />
      <OutcomeSummary view={view} />
    </header>
  );

  // No report artifact: honest for a run that never produced one (e.g. run.failed).
  if (!artifact) {
    return (
      <PageShell runId={run.id}>
        {header}
        <EmptyState
          title="No report for this run"
          description={
            run.status === 'failed' || run.status === 'stopped'
              ? 'This run ended before it produced a validation report. The evidence collected so far is still on the run page.'
              : 'A validation report is generated when the run completes. It will appear here once it’s ready.'
          }
          action={
            <Link
              to={`/runs/${run.id}`}
              className="inline-flex items-center justify-center rounded-control bg-accent px-4 py-2 text-body font-medium text-white hover:bg-accent-hover"
            >
              View run evidence
            </Link>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell runId={run.id}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-page font-semibold text-text-primary">Validation Report</h1>
          <p className="mt-1 text-meta text-text-secondary">
            {run.title}
            {/* Model attribution (T6.3/T6.6) — only when the runner echoed one. */}
            {run.model && (
              <>
                {' · '}
                <span className="font-mono">Model: {run.model}</span>
              </>
            )}
          </p>
          <SummaryRow view={view} />
          <OutcomeSummary view={view} />
        </div>
        {content.isSuccess && content.data.trim() !== '' && (
          <div className="flex items-center gap-2">
            <CopyMarkdownButton text={content.data} />
            <DownloadMarkdownButton artifact={artifact} />
          </div>
        )}
      </div>

      {content.isPending && (
        <p role="status" className="text-body text-text-secondary">
          Loading {artifact.label}…
        </p>
      )}

      {content.isError && (
        <div role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
          <p className="text-body font-medium text-warn">Couldn’t load the report</p>
          <p className="mt-1 text-meta text-text-secondary">
            {artifact.label} could not be fetched from the runner.
          </p>
          <Button variant="secondary" className="mt-3" onClick={() => void content.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {content.isSuccess &&
        (content.data.trim() === '' ? (
          <div role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
            <p className="text-body font-medium text-warn">Report unreadable</p>
            <p className="mt-1 text-meta text-text-secondary">
              {artifact.label} was fetched but contains no content.
            </p>
          </div>
        ) : (
          <ReportView
            markdown={content.data}
            runId={run.id}
            artifacts={view.artifacts}
            checks={view.checks}
            documents={documents}
          />
        ))}
    </PageShell>
  );
}
