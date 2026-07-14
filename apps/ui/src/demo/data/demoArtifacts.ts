// Bundled artifact content for the demo run (T6.5). Generated from the fixture's
// artifacts (packages/contract/fixtures/artifacts) — logs, I2C decodes, code diffs,
// the report — keyed by the artifact id the events reference. The demo-source branch
// in lib/api serves these locally so evidence tabs, decodes, and the report render
// with no runner and no network.
import artifactText from './artifacts.json';

export const DEMO_ARTIFACT_TEXT: Readonly<Record<string, string>> = artifactText;
