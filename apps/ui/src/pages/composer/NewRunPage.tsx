// New Run Composer, draft state (BIBLE §7.2): the hero "Ask Boardex" textarea, the
// board profile selector with context chips backed by the selected profile, inline
// bench readiness (amber degraded warning when devices are offline — composing stays
// allowed), and Create Run Plan → POST /runs → navigate to /runs/:id in composer
// mode. "Edit task" from plan review returns here with the prompt prefilled via
// router state.
//
// Quick Start v0: the board selector has a second mode. With no profiles yet — or via
// "+ New board" — the selector swaps for the Quick Start panel, and Create Run Plan
// COMPILES a board profile from the validated repo path plus the live bench scan
// (quickStartProfile.ts), saves it through the existing profile-creation path, then
// creates the run against it. One click, two entities.
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateRunResponse } from '@boardex/contract';
import { Button } from '../../design';
import { api } from '../../lib/api';
import { addRecentRepoPath } from '../../lib/settings';
import { useBenchStatus } from '../../lib/useBenchStatus';
import { BenchReadiness } from './BenchReadiness';
import { ContextChips } from './ContextChips';
import { QuickStartPanel, useQuickStart } from './QuickStartPanel';
import { buildQuickStartProfile } from './quickStartProfile';

// §7.2, verbatim placeholder.
const PLACEHOLDER =
  'Bring up the BME280 sensor over I2C on this STM32 board. Verify timing and confirm valid temperature/humidity readings over serial.';

interface ComposerPrefill {
  taskPrompt?: string;
  boardProfileId?: string;
  /** Boards' empty state leads with Quick Start and lands here already in it. */
  quickStart?: boolean;
}

type BoardMode = 'existing' | 'quickstart';

export default function NewRunPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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

  // Quick Start (v0). An explicit choice wins; otherwise the mode follows the data —
  // with no profiles on the runner there is nothing to select, so the composer leads
  // with Quick Start instead of an empty dropdown.
  const quick = useQuickStart();
  const [modeChoice, setModeChoice] = useState<BoardMode | null>(
    prefill.quickStart ? 'quickstart' : null,
  );
  const noProfiles = profilesQuery.isSuccess && profiles.length === 0;
  const boardMode: BoardMode = modeChoice ?? (noProfiles ? 'quickstart' : 'existing');

  const bench = useBenchStatus();

  // Model selection (T6.3/T6.6) is feature-detected — never assumed. The picker
  // appears only when the runner advertises MORE THAN ONE model; with zero or one
  // there is nothing to choose, so no UI and no model rides along. Default = first.
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: () => api.getHealth() });
  const models = healthQuery.data?.capabilities?.models ?? [];
  const showModelSelect = models.length > 1;
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const model = showModelSelect ? (modelChoice ?? models[0]) : undefined;

  const create = useMutation({
    mutationFn: async (): Promise<CreateRunResponse> => {
      const request = { taskPrompt: taskPrompt.trim(), ...(model ? { model } : {}) };
      if (boardMode !== 'quickstart') {
        if (!profile) throw new Error('no board profile selected');
        return api.createRun({ ...request, boardProfileId: profile.id });
      }
      // Quick Start: compile the profile from the path + the live bench, save it
      // through the SAME profile-creation path the builder uses (§5.3 POST
      // /board-profiles), then create the run against what the runner echoed back.
      // The id comes from the panel session, not from a fresh mint per attempt: a
      // Create that saved the profile and then failed at POST /runs must, on retry,
      // OVERWRITE that profile rather than leave a second one behind on the runner.
      const compiled = buildQuickStartProfile(
        {
          repoPath: quick.repoPath,
          name: quick.name,
          detectedBuild: quick.detectedBuild,
          bench,
        },
        quick.profileId,
      );
      const saved = await api.saveBoardProfile(compiled);
      addRecentRepoPath(saved.repoPath);
      await queryClient.invalidateQueries({ queryKey: ['board-profiles'] });
      return api.createRun({ ...request, boardProfileId: saved.id });
    },
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });

  const boardReady = boardMode === 'quickstart' ? quick.ready : profile !== null;
  const canCreate = taskPrompt.trim().length > 0 && boardReady && !create.isPending;

  // Frame v2 (T6.1b): the "New Run" title lives in the shell's top bar; the page
  // is the ~760px reading column. T6.1c: the hero block sits ~15vh down so the
  // composer reads vertically balanced instead of hugging the top bar.
  return (
    <main className="mx-auto max-w-3xl px-6 pb-8 pt-[15vh]">
      <p className="text-body text-text-secondary">
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
          className="w-full resize-y rounded-card border border-border bg-surface p-5 text-composer text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
        />

        {boardMode === 'quickstart' ? (
          <QuickStartPanel
            quick={quick}
            onUseExisting={profiles.length > 0 ? () => setModeChoice('existing') : undefined}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <label className="flex items-center gap-2 text-meta text-text-secondary">
              Board profile
              <select
                value={profile?.id ?? ''}
                onChange={(event) => setProfileId(event.target.value)}
                disabled={profiles.length === 0}
                className="rounded-control border border-border bg-surface px-3 py-1.5 text-body text-text-primary focus:border-accent focus:outline-none"
              >
                {profiles.length === 0 && <option value="">No profiles</option>}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {/* Quick Start's entry point beside the selector: a board Boardex has never
                seen needs a path, not a form (§7.2, v0). */}
            <button
              type="button"
              onClick={() => setModeChoice('quickstart')}
              className="rounded-control border border-border px-3 py-1.5 text-meta font-medium text-text-primary transition-colors duration-fast ease-motion hover:bg-canvas"
            >
              + New board
            </button>
            {profile && <ContextChips profile={profile} />}
          </div>
        )}

        {showModelSelect && (
          <label className="flex items-center gap-2 text-meta text-text-secondary">
            Model
            <select
              aria-label="Model"
              value={model ?? ''}
              onChange={(event) => setModelChoice(event.target.value)}
              className="rounded-control border border-border bg-surface px-3 py-1.5 text-body text-text-primary focus:border-accent focus:outline-none"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* In Quick Start there is no profile yet, so there is no reference that could
            be missing — only the bench's own devices are known, which is exactly what a
            null instruments prop reports (§7.2: never an assumed anything). */}
        <BenchReadiness
          bench={bench}
          instruments={boardMode === 'quickstart' ? null : (profile?.instruments ?? null)}
        />

        {create.isError && (
          <p role="alert" className="rounded-card border border-warn bg-warn-bg px-4 py-3 text-body text-warn">
            {boardMode === 'quickstart'
              ? 'Could not save the board and create the run — check that the runner is online, then try again.'
              : 'Could not create the run — check that the runner is online, then try again.'}
          </p>
        )}

        <Button variant="primary" disabled={!canCreate} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating…' : 'Create Run Plan'}
        </Button>
      </div>
    </main>
  );
}
