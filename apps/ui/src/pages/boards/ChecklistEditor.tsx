// Connection Checklist section (BIBLE §7.5, D12): repeatable label+detail rows the
// engineer authors by hand — Boardex draws no wiring diagrams. Order matters: this is
// the list the pre-run gate asks the user to confirm line by line (§7.2), so rows
// reorder. All row operations are the pure helpers in profileDraft.
import { Button } from '../../design';
import { TextField } from './Field';
import {
  addChecklistRow,
  moveChecklistRow,
  removeChecklistRow,
  type ChecklistRow,
  type FieldErrors,
} from './profileDraft';

export interface ChecklistEditorProps {
  rows: ChecklistRow[];
  onChange: (rows: ChecklistRow[]) => void;
  errors: FieldErrors;
}

export function ChecklistEditor({ rows, onChange, errors }: ChecklistEditorProps) {
  const update = (key: string, patch: Partial<ChecklistRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <div>
      {rows.length === 0 ? (
        <p className="text-meta text-text-secondary">
          No connections listed. Runs against this board will have nothing to confirm before
          the plan is approved.
        </p>
      ) : (
        <ol aria-label="Connection checklist" className="space-y-4">
          {rows.map((row, index) => (
            <li
              key={row.key}
              aria-label={`Connection ${index + 1}`}
              className="rounded-card border border-border p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Label"
                  value={row.label}
                  onChange={(label) => update(row.key, { label })}
                  error={errors[`connectionChecklist.${index}.label`]}
                  placeholder="SCL — PB8"
                />
                <TextField
                  label="Detail"
                  value={row.detail}
                  onChange={(detail) => update(row.key, { detail })}
                  error={errors[`connectionChecklist.${index}.detail`]}
                  placeholder="Nucleo PB8 (CN10-3) to BME280 SCL"
                />
              </div>
              <div className="mt-3 flex items-center gap-2">
                {/* Each row is a labelled listitem ("Connection 3"), so the controls
                    need no repeated aria-label of their own. */}
                <Button
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => onChange(moveChecklistRow(rows, row.key, 'up'))}
                >
                  Move up
                </Button>
                <Button
                  variant="ghost"
                  disabled={index === rows.length - 1}
                  onClick={() => onChange(moveChecklistRow(rows, row.key, 'down'))}
                >
                  Move down
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => onChange(removeChecklistRow(rows, row.key))}
                  className="ml-auto"
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <Button variant="secondary" className="mt-4" onClick={() => onChange(addChecklistRow(rows))}>
        Add connection
      </Button>
    </div>
  );
}
