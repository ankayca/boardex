// Documents section (BIBLE §7.5, T6.3): repeatable metadata rows for the reference
// material the runner serves (BoardProfile.documents, §5.3). METADATA ONLY — content
// upload is out of scope; the runner owns the files. Each row is id + label + kind +
// mimeType; kind is a select over the contract's DocumentKind. Row operations are the
// pure helpers in profileDraft.
import { useId } from 'react';
import { Button } from '../../design';
import { TextField } from './Field';
import {
  addDocumentRow,
  DOCUMENT_KINDS,
  removeDocumentRow,
  type DocumentRow,
  type FieldErrors,
} from './profileDraft';

const KIND_LABEL: Record<DocumentRow['kind'], string> = {
  datasheet: 'Datasheet',
  schematic: 'Schematic',
  reference: 'Reference',
};

function KindSelect({
  value,
  onChange,
}: {
  value: DocumentRow['kind'];
  onChange: (kind: DocumentRow['kind']) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-meta font-medium text-text-secondary">
        Kind
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as DocumentRow['kind'])}
        className="mt-1 w-full rounded-button border border-border bg-bg-panel px-3 py-2 text-body text-text-primary focus:border-accent focus:outline-none"
      >
        {DOCUMENT_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {KIND_LABEL[kind]}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface DocumentsEditorProps {
  rows: DocumentRow[];
  onChange: (rows: DocumentRow[]) => void;
  errors: FieldErrors;
}

export function DocumentsEditor({ rows, onChange, errors }: DocumentsEditorProps) {
  const update = (key: string, patch: Partial<DocumentRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <div>
      {rows.length === 0 ? (
        <p className="text-meta text-text-secondary">
          No documents attached. Add datasheets, schematics, or reference material the runner
          serves — the Sources tab and check citations link to them.
        </p>
      ) : (
        <ol aria-label="Documents" className="space-y-4">
          {rows.map((row, index) => (
            <li
              key={row.key}
              aria-label={`Document ${index + 1}`}
              className="rounded-card border border-border p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Document id"
                  value={row.id}
                  onChange={(id) => update(row.key, { id })}
                  error={errors[`documents.${index}.id`]}
                  mono
                  placeholder="doc_bme280_datasheet"
                />
                <TextField
                  label="Label"
                  value={row.label}
                  onChange={(label) => update(row.key, { label })}
                  error={errors[`documents.${index}.label`]}
                  placeholder="BME280 datasheet (excerpt)"
                />
                <KindSelect value={row.kind} onChange={(kind) => update(row.key, { kind })} />
                <TextField
                  label="MIME type"
                  value={row.mimeType}
                  onChange={(mimeType) => update(row.key, { mimeType })}
                  error={errors[`documents.${index}.mimeType`]}
                  mono
                  placeholder="text/markdown"
                />
              </div>
              <div className="mt-3 flex">
                <Button
                  variant="ghost"
                  onClick={() => onChange(removeDocumentRow(rows, row.key))}
                  className="ml-auto"
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <Button variant="secondary" className="mt-4" onClick={() => onChange(addDocumentRow(rows))}>
        Add document
      </Button>
    </div>
  );
}
