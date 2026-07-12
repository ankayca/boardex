# Open contract proposals — backend positions (for the integration call)

Ahmet's positions on the three optional-field proposals from Kerem's
integration one-pager (§5 "Open proposals"). All three follow the §10.5 chain
if accepted: bible §5 edit → contract package → mock runner + fixture → UI →
then our runner emits them. Nothing below is implemented runner-side yet, by
design.

## 1. `Approval.proposal.diffArtifactId?` (bind gate → diff)

**Yes — strongly in favor.** The runner already emits the `code_diff` artifact
before the fix gate opens (edit step → `artifact.created` → diagnosis →
`approval.requested`), so populating the field is one line for us. Today the
UI's "Review Diff" binds to *the run's latest* `code_diff`, which holds only
because edit steps immediately precede gates (Kerem's own T3.3 review note);
an explicit id makes the binding true by construction instead of by pipeline
shape — and stays honest when a future runner interleaves edits. Optional
field, absent = current behavior, zero migration cost.

One decision to make on the call: is it legal for a `diffArtifactId` to
reference an artifact the stream has not announced yet? Our vote: no — the
runner must emit `artifact.created` before the `approval.requested` that cites
it, mirroring the evidence-linking law for checks. Ours already does.

## 2. Mock honoring `POST /runs` `boardProfileId` (§5.6)

**In favor, with a narrow scope.** "Honoring" should mean: the created
RunSummary and `run.created` carry the request's `boardProfileId` (instead of
the fixture's hard-coded `bp_nucleo_f303re`), and an unknown id is answered
with an explicit 4xx or a documented fallback — not that the mock synthesizes
a different story per profile. The real runner already resolves the profile
(canned fallback for unknown ids today; we would align with whatever the call
decides — our preference is 400 on unknown ids, since a silent fallback can
flash the wrong board's commands on a real bench). This tightens §10.4 item 2:
the shared conformance suite could then assert profile round-tripping against
both runners.

## 3. Source-excerpt artifact kind (datasheet citations)

**In favor, as a v-next kind — not needed for the current milestone.** The
scripted runner cites the datasheet only inside `step.log` agent lines and
check `sourceRef` strings ("BME280 datasheet §5.4.1"), which the current
contract already carries. The kind earns its place when the agent loop reads
real documents and the evidence law should apply to citations ("every claim
links to fetchable evidence" — today `sourceRef` is prose, not a link).
Suggested shape when it lands: `kind: "source_excerpt"`, JSON content
`{ source, locator, excerpt }` (document identity, section/page locator,
verbatim excerpt), MIME `application/json`, schema in `artifacts.schema.json`
like the other structured kinds. Checks could then carry `sourceRefArtifactId?`
alongside `sourceRef`. We would not emit it until the §10.5 chain lands.
