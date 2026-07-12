// Sources tab (BIBLE §7.4, T6.3): lists the board profile's documents and renders
// the selected one — markdown through the T5.1 renderer, PDF via a native embed,
// anything else best-effort as plain text. A check's sourceDoc deep-links here with
// the document preselected and the locator highlighted. Every fetch fails closed:
// loading, unfetchable (retryable), and empty each render an explicit state, never a
// blank panel or a crash.
import { useState } from 'react';
import type { BoardDocument } from '@boardex/contract';
import { Button } from '../../design';
import { api } from '../../lib/api';
import { DocumentMarkdown } from './DocumentMarkdown';
import { renderKindForMime, useDocumentContent } from './documentContent';

const KIND_LABEL: Record<BoardDocument['kind'], string> = {
  datasheet: 'Datasheet',
  schematic: 'Schematic',
  reference: 'Reference',
};

export interface SourcesTabProps {
  documents: readonly BoardDocument[];
  /** Deep-link seed: the document to preselect (a check's sourceDoc.documentId). */
  initialDocId: string | null;
  /** Deep-link seed: the locator to highlight within the selected document. */
  locator: string | null;
}

export function SourcesTab({ documents, initialDocId, locator }: SourcesTabProps) {
  // Selection is local: the deep link seeds it, the user can switch freely after.
  // Derived-state reset (the useRunStream pattern): when the deep-linked doc changes,
  // re-seed before painting. A seed that names no known document falls back to the
  // first document, so the panel is never empty when documents exist.
  const seededId =
    (initialDocId && documents.some((doc) => doc.id === initialDocId) ? initialDocId : null) ??
    documents[0]?.id ??
    null;
  const [selection, setSelection] = useState<{ seed: string | null; id: string | null }>({
    seed: initialDocId,
    id: seededId,
  });
  if (selection.seed !== initialDocId) {
    setSelection({ seed: initialDocId, id: seededId });
  }
  const selectedId = selection.id;
  const selected = documents.find((doc) => doc.id === selectedId) ?? null;
  // The locator only applies to the deep-linked document, not one picked by hand.
  const activeLocator = selectedId === initialDocId ? locator : null;

  if (documents.length === 0) {
    return (
      <p role="status" className="text-body text-text-secondary">
        This board profile carries no documents.
      </p>
    );
  }

  return (
    <div className="flex gap-6">
      <nav aria-label="Documents" className="w-56 shrink-0 space-y-1">
        {documents.map((doc) => {
          const active = doc.id === selectedId;
          return (
            <button
              key={doc.id}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => setSelection({ seed: initialDocId, id: doc.id })}
              className={`flex w-full flex-col items-start gap-1 rounded-button border px-3 py-2 text-left transition-colors ${
                active
                  ? 'border-accent bg-neutral-badge-bg'
                  : 'border-border hover:border-border-strong'
              }`}
            >
              <span className="text-body font-medium text-text-primary">{doc.label}</span>
              {/* Neutral pill (§6.1 neutral badge) — a document kind carries no
                  pass/fail/warn semantics, so it never touches green/red/amber. */}
              <span className="inline-flex items-center whitespace-nowrap rounded-full bg-neutral-badge-bg px-2 py-0.5 text-label font-medium uppercase text-neutral-badge">
                {KIND_LABEL[doc.kind]}
              </span>
            </button>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1">
        {selected && <DocumentPanel doc={selected} locator={activeLocator} />}
      </div>
    </div>
  );
}

function DocumentPanel({ doc, locator }: { doc: BoardDocument; locator: string | null }) {
  const kind = renderKindForMime(doc.mimeType);

  // PDF: native embed by reference. An <object> falls back to its children when the
  // browser can't render the PDF — fail-closed with a link out, never a blank frame.
  if (kind === 'pdf') {
    const url = api.documentUrl(doc.id);
    return (
      <object
        data={url}
        type="application/pdf"
        aria-label={doc.label}
        className="h-[70vh] w-full rounded-card border border-border"
      >
        <div role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
          <p className="text-body font-medium text-warn">Couldn’t display the PDF</p>
          <p className="mt-1 text-meta text-text-secondary">
            {doc.label} could not be rendered inline.
          </p>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-meta font-medium text-accent hover:text-accent-hover"
          >
            Open the PDF
          </a>
        </div>
      </object>
    );
  }

  return <TextDocument doc={doc} kind={kind} locator={locator} />;
}

function TextDocument({
  doc,
  kind,
  locator,
}: {
  doc: BoardDocument;
  kind: 'markdown' | 'text';
  locator: string | null;
}) {
  const content = useDocumentContent(doc.id);

  if (content.isPending) {
    return (
      <p role="status" className="text-body text-text-secondary">
        Loading {doc.label}…
      </p>
    );
  }
  // Fail-closed: an unfetchable document is an explicit, retryable state.
  if (content.isError) {
    return (
      <div role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
        <p className="text-body font-medium text-warn">Couldn’t load the document</p>
        <p className="mt-1 text-meta text-text-secondary">
          {doc.label} could not be fetched from the runner.
        </p>
        <Button variant="secondary" className="mt-3" onClick={() => void content.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (content.data.trim() === '') {
    return (
      <div role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3">
        <p className="text-body font-medium text-warn">Document unreadable</p>
        <p className="mt-1 text-meta text-text-secondary">
          {doc.label} was fetched but contains no content.
        </p>
      </div>
    );
  }

  if (kind === 'markdown') {
    return <DocumentMarkdown markdown={content.data} locator={locator} />;
  }
  // Best-effort plain text: a locator that isn't a heading slug has nothing to
  // highlight here, so it is a no-op — the document still renders in full.
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-meta text-text-primary">
      {content.data}
    </pre>
  );
}
