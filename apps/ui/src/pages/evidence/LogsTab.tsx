// Logs tab (BIBLE §7.4, Sprint 7 P0): serial / build / flash logs via the
// LogViewer primitive, navigated by two compact selectors — Iteration [1|2] and
// Type [Build|Flash|Serial] — that can never wrap (the old six flat sub-tabs
// wrapped onto two lines inside the drawer). The find field stays in the
// LogViewer header directly above the output; the log content itself is
// unchanged. Content plumbing (fetch by reference, D4; loading / fetch-error /
// unreadable gates) is the shared ArtifactContent pattern.
import { useMemo, useState } from 'react';
import type { Artifact, ArtifactKind, RunView } from '@boardex/contract';
import { LogViewer } from '../../design';
import { ArtifactContentGate, useArtifactContent } from './ArtifactContent';
import { LOG_KIND_NAME, logMatrix, parseLogText } from './logs';

export interface LogsTabProps {
  view: RunView;
  /** The log artifact a deep link targeted, or null when opened by hand. */
  targetArtifact: Artifact | null;
}

const SEGMENT_BUTTON =
  'h-7 whitespace-nowrap rounded px-3 text-meta font-medium transition-colors duration-fast ease-motion';

function Segmented<T extends string | number>({
  label,
  options,
  selected,
  disabledOptions,
  format,
  onSelect,
}: {
  label: string;
  options: readonly T[];
  selected: T | null;
  /** Options with no artifact behind them for the current cross-axis value. */
  disabledOptions?: ReadonlySet<T>;
  format: (option: T) => string;
  onSelect: (option: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center gap-2">
      <span className="text-metadata font-medium uppercase tracking-wide text-text-secondary">
        {label}
      </span>
      <div className="inline-flex rounded-control border border-border bg-canvas p-0.5">
        {options.map((option) => {
          const isSelected = option === selected;
          const disabled = disabledOptions?.has(option) ?? false;
          return (
            <button
              key={String(option)}
              type="button"
              aria-pressed={isSelected}
              disabled={disabled}
              title={disabled ? `No ${format(option).toLowerCase()} log in this iteration` : undefined}
              onClick={() => onSelect(option)}
              className={`${SEGMENT_BUTTON} ${
                isSelected
                  ? 'bg-surface text-text-primary ring-1 ring-border-strong'
                  : 'text-text-secondary enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50'
              }`}
            >
              {format(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LogsTab({ view, targetArtifact }: LogsTabProps) {
  const matrix = useMemo(() => logMatrix(view), [view]);

  // The deep link picks the selection; the user can switch freely afterwards.
  // Derived-state reset (same pattern as the drawer's tab state): a new
  // ?artifact target re-derives the selection before painting.
  const targetId = targetArtifact?.id ?? null;
  const [selection, setSelection] = useState<{ target: string | null; id: string | null }>({
    target: targetId,
    id: targetId,
  });
  if (selection.target !== targetId) {
    setSelection({ target: targetId, id: targetId });
  }

  const artifactsById = useMemo(
    () => new Map(view.artifacts.map((artifact) => [artifact.id, artifact])),
    [view.artifacts],
  );
  const selected =
    (selection.id !== null ? (artifactsById.get(selection.id) ?? null) : null) ?? matrix.first;
  const combo = selected ? matrix.comboOf(selected.id) : null;

  const select = (artifact: Artifact | null) => {
    if (artifact) setSelection({ target: targetId, id: artifact.id });
  };

  // Switching iteration keeps the current type when that cell exists, else
  // falls to the iteration's first populated cell — the selection never lands
  // on an empty cell.
  const selectIteration = (iteration: number) => {
    const kept = combo ? matrix.at(iteration, combo.kind) : null;
    select(kept ?? matrix.kinds.map((kind) => matrix.at(iteration, kind)).find(Boolean) ?? null);
  };

  const emptyKinds = new Set<ArtifactKind>(
    combo ? matrix.kinds.filter((kind) => matrix.at(combo.iteration, kind) === null) : [],
  );

  const content = useArtifactContent(selected?.id);
  const parsed = useMemo(
    () => (content.data !== undefined ? parseLogText(content.data) : null),
    [content.data],
  );

  if (!selected) {
    return (
      <p role="status" className="text-body text-text-secondary">
        No logs have been captured for this run yet.
      </p>
    );
  }

  return (
    <div>
      <div aria-label="Log navigation" className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Segmented
          label="Iteration"
          options={matrix.iterations}
          selected={combo?.iteration ?? null}
          format={(iteration) => String(iteration)}
          onSelect={selectIteration}
        />
        <Segmented
          label="Type"
          options={matrix.kinds}
          selected={combo?.kind ?? null}
          disabledOptions={emptyKinds}
          format={(kind) => LOG_KIND_NAME[kind] ?? kind}
          onSelect={(kind) => combo && select(matrix.at(combo.iteration, kind))}
        />
      </div>

      {matrix.unassigned.length > 0 && (
        // Logs whose iteration the view can't resolve — reachable, never dropped.
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-metadata text-text-secondary">Unassigned:</span>
          {matrix.unassigned.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              aria-pressed={artifact.id === selected.id}
              onClick={() => select(artifact)}
              className={`rounded-full border border-border px-2.5 py-0.5 text-metadata font-medium transition-colors duration-fast ease-motion ${
                artifact.id === selected.id
                  ? 'bg-neutral-badge-bg text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {artifact.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3">
        <p className="mb-2 text-meta text-text-secondary">{selected.label}</p>
        <ArtifactContentGate artifact={selected} noun="log" content={content} parsed={parsed}>
          {parsed?.ok && <LogViewer lines={parsed.lines} label={selected.label} />}
        </ArtifactContentGate>
      </div>
    </div>
  );
}
