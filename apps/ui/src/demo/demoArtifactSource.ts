// The read-only bridge that installs the demo's bundled artifact text into the api
// layer's demo-source branch (T6.5). This is the ONE demo module that touches lib/api,
// and only to register content for by-reference reads — never a command. The demo's
// command and playback path (useDemoPlayback, demoCommands) import none of this, which
// is what keeps the demo structurally incapable of issuing a real command.
import { setDemoArtifactSource } from '../lib/api';
import { DEMO_ARTIFACT_TEXT } from './data/demoArtifacts';

const DEMO_ARTIFACT_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries(DEMO_ARTIFACT_TEXT),
);

export function installDemoArtifacts(): void {
  setDemoArtifactSource(DEMO_ARTIFACT_MAP);
}

export function uninstallDemoArtifacts(): void {
  setDemoArtifactSource(null);
}
