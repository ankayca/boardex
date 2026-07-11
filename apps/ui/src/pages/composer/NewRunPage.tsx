// New Run Composer, draft state (BIBLE §7.2): the hero "Ask Boardex" textarea, the
// board profile selector with context chips backed by the selected profile, inline
// bench readiness (amber degraded warning when devices are offline — composing stays
// allowed), and Create Run Plan → POST /runs → navigate to /runs/:id in composer
// mode. "Edit task" from plan review returns here with the prompt prefilled via
// router state.
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '../../design';
import { api } from '../../lib/api';
import { useBenchStatus } from '../../lib/useBenchStatus';
import { BenchReadiness } from './BenchReadiness';
import { ContextChips } from './ContextChips';

// §7.2, verbatim placeholder.
const PLACEHOLDER =
  'Bring up the BME280 sensor over I2C on this STM32 board. Verify timing and confirm valid temperature/humidity readings over serial.';

interface ComposerPrefill {
  taskPrompt?: string;
  boardProfileId?: string;
}

export default function NewRunPage() {
  const navigate = useNavigate();
  const prefill = (useLocation().state ?? {}) as ComposerPrefill;
  const [taskPrompt, setTaskPrompt] = useState(prefill.taskPrompt ?? '');
  const [profileId, setProfileId] = useState<string | null>(prefill.boardProfileId ?? null);

  const profilesQuery = useQuery({
    queryKey: ['board-profiles'],
    queryFn: () => api.listBoardProfiles(),
  });
  const profiles = profilesQuery.data ?? [];
  // Explicit selection wins; otherwise the first profile is preselected.
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0] ?? null;

  const bench = useBenchStatus();

  const create = useMutation({
    mutationFn: (request: { taskPrompt: string; boardProfileId: string }) =>
      api.createRun(request),
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });

  const canCreate = taskPrompt.trim().length > 0 && profile !== null && !create.isPending;

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-page font-semibold text-text-primary">New Run</h1>
      <p className="mt-1 text-body text-text-secondary">
        Tell Boardex what to validate. Boardex will plan, run, measure, and report.
      </p>

      <div className="mt-6 space-y-4">
        <textarea
          aria-label="Ask Boardex"
          placeholder={PLACEHOLDER}
          value={taskPrompt}
          onChange={(event) => setTaskPrompt(event.target.value)}
          rows={4}
          autoFocus
          className="w-full resize-y rounded-card border border-border bg-bg-panel p-5 text-composer text-text-primary shadow-subtle placeholder:text-text-secondary focus:border-accent focus:outline-none"
        />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <label className="flex items-center gap-2 text-meta text-text-secondary">
            Board profile
            <select
              value={profile?.id ?? ''}
              onChange={(event) => setProfileId(event.target.value)}
              disabled={profiles.length === 0}
              className="rounded-button border border-border bg-bg-panel px-3 py-1.5 text-body text-text-primary focus:border-accent focus:outline-none"
            >
              {profiles.length === 0 && <option value="">No profiles</option>}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {profile && <ContextChips profile={profile} />}
        </div>

        <BenchReadiness bench={bench} instruments={profile?.instruments ?? null} />

        {create.isError && (
          <p role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3 text-body text-warn">
            Could not create the run — check that the runner is online, then try again.
          </p>
        )}

        <Button
          variant="primary"
          disabled={!canCreate}
          onClick={() => {
            if (!profile) return;
            create.mutate({ taskPrompt: taskPrompt.trim(), boardProfileId: profile.id });
          }}
        >
          {create.isPending ? 'Creating…' : 'Create Run Plan'}
        </Button>
      </div>
    </main>
  );
}
