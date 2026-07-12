// The Board Profile Builder form (BIBLE §7.5): one vertical form, six sections in
// order — Identity · Firmware · Serial · Instruments · Safety · Connection Checklist.
// Not a wizard: engineers scan. Validate Profile calls GET /bench and marks each
// referenced instrument found/missing (advisory). Save runs the contract schema over
// the draft and POSTs it to /board-profiles; field errors land inline.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardProfile } from '@boardex/contract';
import { Button } from '../../design';
import { api } from '../../lib/api';
import { matchInstruments, type InstrumentMatch } from '../../lib/benchReadiness';
import { useBenchStatus } from '../../lib/useBenchStatus';
import { ChecklistEditor } from './ChecklistEditor';
import { DocumentsEditor } from './DocumentsEditor';
import { FormSection, TextField, ToggleField } from './Field';
import { InstrumentField } from './InstrumentField';
import { ValidationPanel } from './ValidationPanel';
import {
  draftInstruments,
  validateDraft,
  type ChecklistRow,
  type FieldErrors,
  type ProfileDraft,
} from './profileDraft';

export interface ProfileFormProps {
  mode: 'new' | 'edit';
  initial: ProfileDraft;
  /** Called with the profile the runner echoed back (§5.3 POST /board-profiles). */
  onSaved: (profile: BoardProfile) => void;
}

export function ProfileForm({ mode, initial, onSaved }: ProfileFormProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [matches, setMatches] = useState<InstrumentMatch[] | null>(null);

  // Populates the detected-device picker — through useBenchStatus like every other
  // bench surface (T5.0/F8): the liveness rule from T4.2 F1 (a snapshot is dropped
  // when the connection that delivered it dies) applies to the picker too; a private
  // ['bench'] query here would happily offer devices from a bench we can no longer
  // see. Validate Profile below still re-fetches rather than reading any snapshot:
  // "validated" must mean "checked against the bench just now".
  const bench = useBenchStatus();

  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  // Editing an instrument invalidates the last validation — a stale green dot next to a
  // field the user just retyped would be a lie.
  const setInstrument = (key: 'debugProbe' | 'logicAnalyzer', value: string) => {
    setMatches(null);
    set(key, value);
  };

  const validate = useMutation({
    mutationFn: () => api.getBench(),
    onSuccess: (bench) => setMatches(matchInstruments(draftInstruments(draft), bench)),
  });

  const save = useMutation({
    mutationFn: (profile: BoardProfile) => api.saveBoardProfile(profile),
    onSuccess: async (saved) => {
      // The composer's profile list and every context chip read this query key.
      await queryClient.invalidateQueries({ queryKey: ['board-profiles'] });
      onSaved(saved);
    },
  });

  const submit = () => {
    const result = validateDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(result.profile);
  };

  const errorCount = Object.keys(errors).length;

  return (
    <form
      className="space-y-8"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <FormSection title="Identity">
        <TextField
          label="Name"
          value={draft.name}
          onChange={(value) => set('name', value)}
          error={errors['name']}
          placeholder="Nucleo-F303RE"
        />
        <TextField
          label="MCU"
          value={draft.mcu}
          onChange={(value) => set('mcu', value)}
          error={errors['mcu']}
          placeholder="STM32F303RE (Cortex-M4)"
        />
      </FormSection>

      <FormSection title="Firmware" hint="Run from the repo root; Boardex executes these verbatim.">
        <TextField
          label="Repo path"
          value={draft.repoPath}
          onChange={(value) => set('repoPath', value)}
          error={errors['repoPath']}
          mono
          placeholder="/bench/firmware/bme280-f303re"
        />
        <TextField
          label="Build command"
          value={draft.buildCommand}
          onChange={(value) => set('buildCommand', value)}
          error={errors['buildCommand']}
          mono
          placeholder="make clean && make"
        />
        <TextField
          label="Flash command"
          value={draft.flashCommand}
          onChange={(value) => set('flashCommand', value)}
          error={errors['flashCommand']}
          mono
          placeholder="pyocd flash --target stm32f303retx firmware.elf"
        />
        <TextField
          label="Reset command"
          value={draft.resetCommand}
          onChange={(value) => set('resetCommand', value)}
          error={errors['resetCommand']}
          mono
          placeholder="pyocd reset --target stm32f303retx"
        />
      </FormSection>

      <FormSection title="Serial">
        <TextField
          label="Port"
          value={draft.serialPort}
          onChange={(value) => set('serialPort', value)}
          error={errors['serial.port']}
          mono
          placeholder="/dev/ttyACM0"
        />
        <TextField
          label="Baud"
          value={draft.serialBaud}
          onChange={(value) => set('serialBaud', value)}
          error={errors['serial.baud']}
          mono
          inputMode="numeric"
          placeholder="115200"
        />
      </FormSection>

      <FormSection
        title="Instruments"
        hint="Pick a detected device to bind this profile to its stable id, or type a name."
      >
        <InstrumentField
          label="Debug probe"
          kind="debug_probe"
          value={draft.debugProbe}
          onChange={(value) => setInstrument('debugProbe', value)}
          error={errors['instruments.debugProbe']}
          bench={bench}
        />
        <InstrumentField
          label="Logic analyzer"
          kind="logic_analyzer"
          value={draft.logicAnalyzer}
          onChange={(value) => setInstrument('logicAnalyzer', value)}
          error={errors['instruments.logicAnalyzer']}
          hint="Optional — leave blank if this board is validated without one."
          bench={bench}
        />

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button variant="secondary" onClick={() => validate.mutate()} disabled={validate.isPending}>
            {validate.isPending ? 'Validating…' : 'Validate Profile'}
          </Button>
          {validate.isError && (
            <p role="alert" className="text-meta text-warn">
              Could not reach the runner to read the bench. Check that it is online, then
              validate again.
            </p>
          )}
        </div>
        {matches && <ValidationPanel matches={matches} />}
      </FormSection>

      <FormSection title="Safety">
        <TextField
          label="Max iterations"
          value={draft.maxIterations}
          onChange={(value) => set('maxIterations', value)}
          error={errors['safety.maxIterations']}
          inputMode="numeric"
          placeholder="3"
        />
        <ToggleField
          label="Flash requires approval"
          description="Boardex pauses for a human before writing firmware to this board."
          checked={draft.flashRequiresApproval}
          onChange={(value) => set('flashRequiresApproval', value)}
        />
        <TextField
          label="Power note"
          value={draft.powerNote}
          onChange={(value) => set('powerNote', value)}
          error={errors['safety.powerNote']}
          hint="Manual power only (D11): what the operator must confirm before a run."
          placeholder="Manual power: board powered over USB, 3V3 confirmed."
        />
      </FormSection>

      <FormSection
        title="Connection Checklist"
        hint="Confirmed line by line before every run is approved."
      >
        <ChecklistEditor
          rows={draft.checklist}
          onChange={(rows: ChecklistRow[]) => set('checklist', rows)}
          errors={errors}
        />
      </FormSection>

      <FormSection
        title="Documents"
        hint="Reference material the runner serves (datasheets, schematics). Metadata only — the runner owns the file content; this edits the id, label, kind, and MIME type."
      >
        <DocumentsEditor
          rows={draft.documents}
          onChange={(rows) => set('documents', rows)}
          errors={errors}
        />
      </FormSection>

      {errorCount > 0 && (
        <p role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3 text-body text-warn">
          {errorCount === 1
            ? 'One field needs attention before this profile can be saved.'
            : `${errorCount} fields need attention before this profile can be saved.`}
        </p>
      )}

      {/* One message for every failed save. §5.3 gives 409 a meaning only for commands
          invalid against a RUN's state; no runner implements optimistic concurrency on
          board profiles, so nothing here may claim a stale-edit conflict (review F3). */}
      {save.isError && (
        <p role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3 text-body text-warn">
          Could not save the profile — check that the runner is online, then try again.
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : mode === 'new' ? 'Create Profile' : 'Save Profile'}
        </Button>
      </div>
    </form>
  );
}
