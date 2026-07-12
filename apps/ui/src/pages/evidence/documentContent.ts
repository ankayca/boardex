// Document-content plumbing for the Sources tab (§7.4, T6.3). Fetches a profile
// document's raw text by reference (GET /documents/{id}) and caches it immutable
// (documents are runner-owned reference material, not per-run state). MIME
// classification decides how the tab renders: markdown via the T5.1 renderer, PDF
// via a native embed, anything else best-effort as plain text.
import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../../lib/api';

export function useDocumentContent(documentId: string | undefined): UseQueryResult<string> {
  return useQuery({
    queryKey: ['document-content', documentId],
    queryFn: documentId ? () => api.getDocumentText(documentId) : skipToken,
    staleTime: Infinity, // documents are runner-owned reference material, fetched by reference
  });
}

export type DocumentRenderKind = 'markdown' | 'pdf' | 'text';

// How the Sources tab renders a document, from its declared mimeType. Markdown and
// PDF get first-class treatment (§7.4 stage 2); every other type falls back to plain
// text so a document is never a dead panel.
export function renderKindForMime(mimeType: string): DocumentRenderKind {
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'markdown';
  return 'text';
}
