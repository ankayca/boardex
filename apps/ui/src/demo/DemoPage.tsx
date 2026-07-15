// First-run demo mode (T6.5, BIBLE §7.1). A self-contained, read-only replay of a
// recorded agent run at /demo/*: the bundled events play through a dedicated run store
// exactly like a live stream (useDemoPlayback), reduced by the contract reducer and
// rendered through the REAL workspace surfaces — so what a newcomer watches is exactly
// what a live run looks like. A guided tour narrates the moments as they land.
//
// The demo is structurally command-safe: the workspace's rail issues its stop /
// resolve-approval through a local RunCommands (makeDemoCommands) — no api client on
// this path — and evidence deep links resolve to /demo via EvidenceBaseContext. The
// only api touch is the read-only artifact bridge (installDemoArtifacts), which lets
// the shared evidence tabs and report fetch the bundled artifact content offline.
import { useEffect, useMemo, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { RunCommandsProvider } from '../lib/runCommands';
import { EvidenceDrawer } from '../pages/evidence/EvidenceDrawer';
import { EvidenceBaseProvider } from '../pages/workspace/evidenceBase';
import { WorkspacePage } from '../pages/workspace/WorkspacePage';
import { DEMO_PROFILE } from './data/demoProfile';
import { DemoReport } from './DemoReport';
import { DemoRejectNotice } from './DemoRejectNotice';
import { DemoShell } from './DemoShell';
import { installDemoArtifacts, uninstallDemoArtifacts } from './demoArtifactSource';
import { makeDemoCommands } from './demoCommands';
import { Tour } from './Tour';
import { useDemoPlayback } from './useDemoPlayback';

export default function DemoPage() {
  const navigate = useNavigate();
  const playback = useDemoPlayback();
  const { view } = playback;
  // Set when the user rejects at an approval gate (F1): the recording was approved, so
  // rejecting cannot continue playback — it surfaces the honest notice and exits.
  const [rejected, setRejected] = useState(false);

  const onReport = useMatch('/demo/report') !== null;
  const onEvidence = useMatch('/demo/evidence') !== null;

  // Serve the bundled artifacts through the api demo-source branch while mounted.
  useEffect(() => {
    installDemoArtifacts();
    return () => uninstallDemoArtifacts();
  }, []);

  const exit = () => navigate('/');

  const commands = useMemo(
    () =>
      makeDemoCommands({
        exit,
        resolve: playback.advanceToApprovalResolution,
        // Reject: freeze the replay behind the notice, then leave — never fabricate a
        // rejected ending the recording doesn't have.
        reject: () => {
          playback.pause();
          setRejected(true);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, playback.advanceToApprovalResolution, playback.pause],
  );

  return (
    <RunCommandsProvider value={commands}>
      <EvidenceBaseProvider base="/demo">
        <DemoShell playback={playback} onExit={exit}>
          {view === null ? (
            <main className="mx-auto max-w-3xl px-6 py-16">
              <p className="text-body text-text-secondary">Starting the demo…</p>
            </main>
          ) : onReport ? (
            <DemoReport view={view} />
          ) : (
            <>
              <WorkspacePage
                view={view}
                profile={DEMO_PROFILE}
                profileLoading={false}
                bench={null}
                connection="open"
                demoMode
              />
              {onEvidence && <EvidenceDrawer view={view} onClose={() => navigate('/demo')} />}
              <Tour view={view} />
            </>
          )}
        </DemoShell>
        {rejected && <DemoRejectNotice onExit={exit} />}
      </EvidenceBaseProvider>
    </RunCommandsProvider>
  );
}
