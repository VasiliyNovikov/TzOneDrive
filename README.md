# TzOneDrive
OneDrive for Tizen TV

A vanilla JavaScript, HTML and CSS **synthetic-photo viewer** and a
**Copilot CLI software-factory scaffold**. The MIT license is unchanged.
No OneDrive account, Azure resources, inference credentials or TV are needed
for browser development and the mock lifecycle.

**Real delivery is deliberately disabled until bootstrap.** A mock PASS is
not a physical-TV PASS. No physical TV, camera, signing certificate, Copilot
inference entitlement or live model availability was available during
scaffolding. Production inference verification and authenticated private device
transport remain blocked; the local evidence bridge alone is not readiness.
These gates require verified evidence and infrastructure, not just configuration.
This scaffold must be reviewed and merged by the owner, not this factory.
The actual default branch was inspected: `master`. The closed, empty earlier
scaffold PR #1 is not reused.

## Try it in a browser or Codespaces

Use Node.js 22 and the committed lockfile:

```sh
npm ci --ignore-scripts
npm start
# Open http://localhost:4173
```

Codespaces uses `.devcontainer/devcontainer.json`; keep the forwarded port
private. No mandatory bundler or application runtime dependency is involved.
Use arrows, Enter, and Escape/Backspace as the TV remote. The sign-in screen is
intentionally a placeholder; all folders and pictures are bundled synthetic
fixtures. Diagnostics show the build, actual user agent, viewport and last key.
Every screen retains the full commit and a `FRAME` marker. Number keys replace
its rolling six-digit challenge without moving focus or restarting playback,
so the camera harness can require a newly observed frame rather than a stale
picture. The physical remote bridge and camera decoder must support this
contract; browser key tests do not verify the real bridge.

```sh
npm test
npx playwright install --with-deps chromium
npm run test:browser
npm run build
npm run check
npm run factory:mock
```

The build copies versioned local assets and a Tizen `config.xml` into `dist/`.
Development builds are not deployment attestations. Production must use a
full, immutable commit as `BUILD_ID` and retain the manifest and package hash.
Do not publish a signed package or camera images merely because a test passed.

### Hosted browser preview — no TV required

Use **GitHub Pages**, not a GitHub App installation, for static hosting.
After the workflow is merged into `master` and Pages is configured, the expected
default preview URL is **https://vasiliynovikov.github.io/TzOneDrive/**.
The deployment environment reports the actual URL; this link is not a claim
that the first deployment has already succeeded.

One-time owner setup is tracked in
[issue #3](https://github.com/VasiliyNovikov/TzOneDrive/issues/3):

1. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
2. Restrict the **github-pages** environment to the `master` deployment branch.
   Required environment reviewers will pause each publish; omit that requirement
   only if unattended publishing is intended. Keep normal branch protections.
3. Allow the pinned GitHub-owned Actions used by the workflow, then push/merge to
   `master`, or select **Actions → Web preview (GitHub Pages) → Run workflow**
   on `master` to deploy after setup.

Each `master` push runs unit, syntax, build and Chromium checks plus the bounded
factory mock before uploading **only `dist/app`**. Browser tests exercise the
built assets under `/TzOneDrive/` at both TV resolutions. The separate deploy job
publishes that same artifact with Pages/OIDC permissions; it does not check out
or execute application code. PRs, other branches and forks cannot publish
through this workflow. Concurrent deployments are serialized without cancelling
an in-progress publish. Failed checks prevent publication.

This is a public, synthetic-photo preview: Microsoft sign-in is still a
placeholder. It requires no TV, Azure, inference token, GitHub App private key,
signing certificate or LAN runner. Do not add private photos or credentials to
the published assets. Use arrows, Enter and Escape/Backspace as the remote;
the visible full build ID identifies the deployed commit.

To reproduce the Pages-path checks locally after installing Chromium:

```sh
npm run build
APP_ROOT=dist/app APP_BASE_PATH=/TzOneDrive/ npm run test:browser
# Or serve the built preview for manual testing:
APP_ROOT=dist/app APP_BASE_PATH=/TzOneDrive/ npm start
# Open http://localhost:4173/TzOneDrive/
```

**Factory status:** the browser checks and bounded synthetic factory lifecycle
can run now, but this does **not** enable autonomous model-driven development or
physical delivery. The real controller still requires App/inference bootstrap,
verified model telemetry and a physical acceptance path. Do not flip its enable
or stop flags to bypass those gates. Owner input and the separate browser-only
completion target are tracked in
[issue #5](https://github.com/VasiliyNovikov/TzOneDrive/issues/5).
Deferred TV, signing, remote, camera and private-host setup is tracked in
[issue #4](https://github.com/VasiliyNovikov/TzOneDrive/issues/4); it does not block
Pages. All three issues are assigned to the repository owner. A browser or mock
PASS must never be presented as physical-TV acceptance.

## Architecture and boundaries

| Area | Responsibility |
| --- | --- |
| `app/` | Explicit application state, rendering, directional focus, browser/Tizen platform adapters, bounded image loading and mock provider |
| `scripts/` | Local static server, deterministic asset packaging and syntax/workflow guardrails |
| `factory/controller.mjs`, `store.mjs` | Deterministic transitions, intent/receipt persistence, attempts, dependencies and recovery |
| `factory/model-policy.*`, `cli.mjs` | Central role policy and actual non-interactive Copilot CLI invocation |
| `factory/github-*.mjs`, `worker.mjs` | Scoped repository operations, explicit workflow handoffs and independent cloud stages |
| `factory/device.mjs`, `device-bridge.mjs`, `acceptance.mjs`, `adapters/` | Signed deployment, private provenance receipts, bounded remote/camera steps and strict acceptance evidence |
| `.github/workflows/` | Secretless CI and opt-in, authorized factory orchestration |

The control plane is deterministic code, **not an agent deciding whether to
grant itself privileges**. Planning, implementation/repair, independent review,
and visual acceptance are distinct roles. Native CLI subagents and custom-agent
configuration are not permitted to introduce their own models. Application
workers produce bounded data, not shell commands for the controller.

The lifecycle is:

```
trusted goal → backlog → plan → implement → PR → independent validation
              ↑                              ↓ bounded repair
next task ← physical acceptance ← deploy ← exact-tested-commit merge
```

Tasks have stable IDs, dependencies, attempts, states and correlated evidence.
Only one implementation is active initially. Persisted intents precede side
effects; retries reuse the intent identity, not a new PR or deployment identity.
Transient failures back off; expiration, exhausted attempts and no progress
block work instead of looping forever. Acceptance FAIL is a repair/blocked
outcome; INCONCLUSIVE is never delivery success.

### Local operation, stopping and recovery

Use a separate state directory for each synthetic experiment:

```sh
npm run factory:mock -- --state-dir .factory-local/pass
npm run factory:mock -- --state-dir .factory-local/transient --scenario transient
npm run factory:mock -- --state-dir .factory-local/missing-camera --scenario missing-camera
```

The JSON summary reports the actual task outcome; process completion alone is
not a delivery verdict. Inspect `state.json` and `mock-effects.json` in the
selected directory for persisted intents, receipts, attempts and simulation
labels. Rerun the same command to resume; a delivered run performs no new work.
The `crash` scenario deliberately fails once after a simulated side effect:
rerunning with the same state directory recovers the original intent.

Set `FACTORY_STOP=true` or create `STOP` in that state directory to stop before
the next dispatch. Remove the stop condition and rerun to resume an unexpired,
nonterminal run. Do not delete live locks, reset attempt counters or rewrite
receipts. Unknown lock ownership requires operator investigation. Expired or
blocked runs retain their evidence and require a separately approved new run,
not an automatic retry with erased history.

Production workflow tickets are saved before dispatch. After an interrupted
or ambiguous handoff, recovery only polls that ticket; it never blindly sends
the request again. A crash before the request can therefore end in bounded
blocking with no workflow created. Inspect the evidence before starting a
separate approved run. Existing merged PRs must still have exactly the tested
tree before the controller accepts the merge.

The device CLI can also run without hardware:

```sh
node factory/device.mjs diagnostics --config config/device.example.json
node factory/device.mjs deploy --config config/device.example.json
node factory/device.mjs accept --config config/device.example.json
```

The example configuration is explicitly **mock**. Device exit codes are
`0` for PASS, `1` for FAIL and `2` for INCONCLUSIVE; mock reports always have
`gateEligible: false`. A deploy PASS only means install/launch steps completed,
not that camera acceptance passed. Optional `--report` paths must be new files
in a local project subdirectory; reports are not overwritten. Keep real
configuration outside version control and pass its absolute path. Never
publish real CLI output, camera frames or local reports without privacy review.

Application task output may change only the allowed application files. It may
not edit tests, acceptance criteria, signing configuration, workflows, model
policy or the controller. **Factory maintenance is a separate owner-reviewed
operation**, not an application task with a conveniently expanded allowlist.
Tests and review must match the exact candidate commit. Merge must compare the
head SHA; deployment must retain the relationship between tested source,
merged tree, package hash, observed build and acceptance evidence.

## Quality-first model policy

Requested preferences are **display names**, not assumed API identifiers:

| Role | Requested selection |
| --- | --- |
| Plan, implement, repair | GPT Astra flagship, requested as GPT-6 Astra; highest supported effort |
| Independent review | Claude Opus flagship, requested as Claude Opus 5; highest supported effort |
| Visual acceptance | Owner-explicitly-approved flagship with validated image-input support |

These preferences do not change the model of the initial cloud agent session.
`MAX` is not a suffix to append to a model ID. Reasoning levels and model IDs
are separate settings; the highest level must be validated **for that model**.
There is no Auto selection and no approved cheaper fallback.

The production CLI is pinned to **`@github/copilot@1.0.83`**. Its actual
`--help` was inspected locally, including `--model`, `--effort`,
`--attachment`, `--output-format json`, `--no-custom-instructions`,
`--available-tools`, and `--no-auto-update`. This confirms interfaces, not
authenticated availability or modality for a particular model.

The central policy fails closed until a validated catalog/resolution meets
the required role, effort and modality. Every invocation pins its selection.
The wrapper isolates configuration and disables alternate providers,
unapproved overrides and native agent delegation. A requested model setting
alone does not guarantee that the CLI never falls back. Unapproved response
identities, missing required telemetry and failed inference must not produce
valid review or acceptance evidence.

**Configured is not verified.** Preserve CLI version, requested policy,
catalog evidence, selected ID/effort and any exposed response telemetry
separately. Do not label a configured model as an observed backend model.
No real inference was performed during scaffolding.

The response-telemetry parser is also an explicit implementation gate:
`verifyTelemetry()` currently rejects every inference result with
`TELEMETRY_SCHEMA_UNVERIFIED`. Populating a catalog or enabling a repository
variable does not remove that gate. Telemetry loading now rejects oversized,
non-UTF-8 and linked files, but safe input loading is not model verification.

Exact-version static inspection verified the Linux npm archive's integrity
(SHA-256 `23906ffd14c5e29fc1325138fba7d8ea1a397e02ffdcd36383fe66e4d196ba46`).
Its native `runtime.node` is stripped; pooled strings include
`FileSpanExporter`, `gen_ai.response.model`, and
`gen_ai.request.reasoning.level`, but do not establish their JSON structure,
types or value provenance. The documented JSON-lines exporter must not be
assumed to use OTLP JSON. The documentation calls the response model
“Resolved model”; neither that wording nor a matching requested/response
string proves that the value came from the backend rather than a fallback.
No authenticated telemetry capture or real inference was obtained.

Before implementing acceptance, obtain a supported exact-version exporter
contract and verified response-model setter semantics, then regression-test
sanitized evidence. Account for every provider dispatch, including failed or
partial calls, and cumulative histogram snapshots without double-counting.
Requested reasoning levels remain distinct from unavailable backend-effort
verification. Never substitute the requested model for an observed response.

### Refresh and controlled upgrades

1. Stop intake and let no in-flight run change its pinned policy.
2. Inspect the official CLI release and its `--help`, `help config`,
   `help environment`, and `help monitoring`.
3. In an authenticated isolated bootstrap session inspect the supported model
   selector and the available reasoning levels. Validate the requested
   flagship against primary documentation; do not scrape an undocumented API.
4. Validate real inference, response-model telemetry and the image interface
   using synthetic images. A visible display name alone is not validation.
5. Review and promote a complete catalog/policy snapshot, including its
   evidence and validity period. A successor must be in the approved family
   and pass the same checks. Visual-model approval remains explicit.
6. For a CLI upgrade, change the exact package pin, check advisories/integrity,
   recheck configuration precedence, fallback behavior, output schemas,
   telemetry and attachments, and run the regression suite before promotion.
7. Start a new run. Never silently upgrade an already-running task.

There is no invented “latest flagship” endpoint. Where the supported CLI only
offers interactive discovery, the refresh step is an explicit maintenance
procedure, not an alleged automatic discovery API. An expired/unverifiable
catalog blocks delivery. Subscription coverage does not bypass rate limits,
quotas or usage limits; bounded backoff and experiment deadlines still apply.

## Permissions and public-repository security

* Use a **dedicated GitHub App installed only on
  `VasiliyNovikov/TzOneDrive`**, not “all repositories”. Give it only the
  repository permissions used by the controller. Scope each short-lived
  installation token to this repository and its current job.
* Copilot inference authentication is separate. Use the official supported
  inference authentication with **Copilot Requests only**, no repository
  permissions. Do not use a broad personal repository PAT, personal SSH key,
  or the App installation token as inference authentication.
* Credentialed controller/publisher steps never execute generated app code,
  package scripts, task-provided commands or CLI tools. Workers do not receive
  the App private key, signing certificates, LAN credentials or Azure identity.
* Inputs from public issues, PRs, comments, images, code and model output are
  untrusted. They cannot authorize intake, expand permissions, change
  acceptance criteria or dispatch privileged work. There is no
  `pull_request_target` execution path.
* The default-branch harness and owner-approved configuration are trusted.
  Explicit App-based workflow dispatch and correlated polling are used;
  `GITHUB_TOKEN`-generated pushes are not assumed to trigger downstream work.
  Current GitHub documentation also describes approval-required runs for
  certain `GITHUB_TOKEN`-generated PR events; those are not the delivery bus.
* Linux process, disk and network isolation are security boundaries; prompts,
  tool denial and path allowlists alone are not a sandbox. Use an ephemeral
  cloud worker. Do not expose other repositories or credentials on its disk.
* Treat a LAN runner as privileged. Dedicate it to this repository and workflow,
  isolate it from other LAN services, restrict egress, and keep the TV/camera
  on an isolated network. Never register it for general public-PR workloads.
  Repository runner labels by themselves are **not** access controls.

### Actions and bootstrap configuration

| Workflow | Behavior |
| --- | --- |
| `ci.yml` | Secretless unit, syntax, build, required Chromium and mock lifecycle checks on pushes/PRs; ledger pushes are excluded |
| `web-preview.yml` | Pushes to `master` or manual dispatch on `master`: secretless checks, built Pages-path browser tests and bounded factory mock, then static-only GitHub Pages publishing |
| `factory-mock.yml` | Owner/default-branch manual dispatch of a bounded synthetic scenario |
| `factory-controller.yml` | Opt-in owner dispatch or separately enabled schedule; resumes the durable `factory-ledger` branch using a repository-scoped App token |
| `factory-worker.yml` | App-authorized, intent-correlated planning/implementation/repair; independent browser and review jobs combine matching same-run receipts |
| `factory-device.yml` | App-authorized **INCONCLUSIVE bootstrap stub**; no LAN runner, signing, installation, camera or inference is invoked |

The device workflow is intentionally not a production deployment path. Before
replacing its stub, implement independently enforced private runner admission,
and authenticated private receipt transport. The local bridge implements
per-device serialization, private evidence retention, and bindings between
tested source, merged source, unsigned manifest hash, signed widget hash and
camera acceptance. These hashes are different identities and must not be
substituted for each other. No repository variable supplies the missing
admission or transport.

### Private device bridge contract

`factory/device-bridge.mjs` exports `runPrivateDeviceBridge` for a future,
independently admitted private deployment process. It is **not** an HTTP service,
a public workflow runner, or an implemented receipt transport. The public
GitHub adapter rejects deployment artifacts as physical acceptance evidence.
The factory remains disabled.

The entry point accepts only the six authorized dispatch `inputs` and an
absolute operator-owned `configPath`. It rechecks the App dispatch, current
default branch, durable deployment intent, independently tested manifest and
merged PR/tree through a read-only repository credential (`FACTORY_READ_TOKEN`).
The calling infrastructure must independently authenticate the dispatch
environment; environment strings are not proof of runner admission.

On Linux, the checked-out harness must exactly match the authorized default
commit, with tested and merged commits available locally. Untracked harness
inputs, symlinks, changed files and group/world-writable inputs are rejected.
Only the trusted build implementation runs: candidate package scripts do not.
The bridge rebuilds the tested assets, compares their manifest, rebuilds with
the merged SHA, invokes concrete device adapters, and verifies the signed WGT
payload against the merged unsigned manifest. XML-signature trust remains the
Samsung SDK's responsibility.

Prepare private operator configuration from the device example, but omit
`expectedBuild`, `projectRoot`, `appDir`, `manifestPath`, `packageName` and
`mock`: the bridge owns build identity and paths and accepts only real adapters.
Use absolute SDK/remote/decoder paths, the physical device serial, signing
profile, reviewed visual configuration and explicit camera-inference consent.
The configuration file and its parent directory must be owned by the host
user with no group/other permissions. Do not commit either.

The bridge creates `device-bridge-private/` beside that configuration, with
a lock keyed to the device and exclusive per-intent directories. Configure one
canonical private directory and serial for each physical device; multiple
hosts/configuration roots require external serialization. Reused intent
directories and crash-surviving locks block replay: investigate and reconcile
the installed build rather than deleting them to retry.

Raw frames, reports and manifests remain private; filenames bind reports to
their hashes. The returned receipt contains bounded identities, hashes and
verdicts, not frames or diagnostics. Its schema validator checks correlation,
**not producer authentication**. Select and review an authenticated private
transport before connecting receipts to the controller. No local synthetic
receipt test constitutes physical acceptance.

A verified installation keeps a deployment PASS even if its nested camera
verdict is FAIL or INCONCLUSIVE. `deviceReceiptForStage` routes that same receipt
to the controller's separate acceptance stage: FAIL can trigger acceptance
repair, and INCONCLUSIVE does not reinstall the package. Polling acceptance
must not call deployment again. Only an acceptance PASS can mean delivery.
The routing helper preserves provenance only for concrete in-process bridge
receipts; parsing JSON or relabeling a mock cannot grant that provenance.

Configure credentials only after reviewing the default-branch harness:

| Setting | Location and boundary |
| --- | --- |
| `FACTORY_ENABLED` | Repository variable; must be `true` **and** trusted config must have `enabled: true`, `stop: false` |
| `FACTORY_STOP` | Repository variable; `true` prevents new production work; trusted config `stop: true` independently stops it |
| `FACTORY_SCHEDULE_ENABLED` | Repository variable; separate opt-in for the five-minute controller schedule |
| `FACTORY_APP_ID` | Repository variable matching the dedicated App ID in trusted config; configure its exact `appBotLogin` too |
| `FACTORY_APP_PRIVATE_KEY` | Secret in the default-branch-restricted `factory-control` environment only; token requests are limited to this repository and Actions, Contents and Pull requests write permissions |
| `COPILOT_GITHUB_TOKEN` | Secret in the default-branch-restricted `factory-inference` environment only; dedicated scope-reviewed inference credential, never repository-write authentication |

Workers use only read-only `GITHUB_TOKEN` access to verify repository state.
Checkout credentials are not persisted; controller jobs do not run app code,
package scripts or inference. Only bounded structured receipts are uploaded,
with short retention; raw camera and inference logs are not public artifacts.
Keep goals and fixtures synthetic while those receipts are public.

Leave production activation off until telemetry verification, private admission
and transport, and all physical/model bootstrap gates are complete. A dispatched
workflow finishing is not proof of delivery; inspect the correlated receipt
and durable controller status. Stop scheduled intake, set `FACTORY_STOP=true`
and cancel in-flight runs for an emergency stop; already-dispatched jobs are
not revoked merely by changing a variable.

The repo API available during this task confirmed the default branch but did
not expose auto-merge/protection settings. A further authenticated settings
read was unavailable; the earlier report that auto-merge was disabled is **not
a current verification**. Bootstrap must recheck settings, required checks,
review requirements and App permissions. Do not disable protections to make
the loop pass. If protections require human review, a no-click loop is blocked
until the owner explicitly chooses a compatible policy.

## First real TV milestone — bootstrap checklist

Primary target: **Samsung Frame GQ32LS03CBUXZG**, German 32-inch 2023,
**1920×1080**. Chromium 94/Tizen 7 is only a provisional original-generation
baseline. Installed updates are not evidence of the actual application
runtime. Read diagnostics on the installed TV first.

The milestone is exactly:

**deploy diagnostic build → verify version → remote navigation →
camera acceptance → deliberately broken build rejected**

1. **Browser baseline.** Run the secretless tests and mock lifecycle. Review
   this initial PR manually. Keep real factory activation off.
2. **Linux host.** Install a Samsung-supported TV SDK/Tizen Studio release,
   matching Java/system dependencies and TV extensions, `sdb`, the `tizen`
   CLI, and a camera capture tool such as FFmpeg. Check the SDK release's
   supported Linux distributions rather than assuming every Ubuntu version
   works. Configure absolute executable paths and run the diagnostics command.
   Keep the reviewed harness separate from candidate checkouts; never execute
   candidate package scripts on the signing/LAN host.
3. **TV network.** Turn the TV on. Enable TV Developer Mode, set the development
   host IP and perform the documented restart. Check direct network
   connectivity from the dedicated runner. Use an explicit target TV/serial.
4. **Signing.** Create an author/distributor signing profile using Samsung's
   certificate tools and the physical device ID; grant installation
   permission on that device. Keep keys, passwords and profiles only on the
   dedicated deployment host or appropriately restricted deployment secrets.
   A profile name is not the certificate itself.
5. **Remote.** Pair and verify the operator-selected IR/network remote bridge.
   Configure the remote adapter with a trusted executable and supported key
   mapping. Do not assume Samsung websocket pairing, power-on or private
   remote APIs work on this model.
6. **Camera.** Select the Linux camera device, resolution and screen crop.
   Point it only at the TV. Test fresh captures after actions and configure an
   independent build detector that reads the displayed full build ID and
   six-digit `FRAME` challenge. It receives the captured file, request ID and
   hash, not the expected build or challenge; it must decode the image rather
   than echo caller-provided expectations.
7. **Diagnostic package.** Build an immutable synthetic-only commit, prepare
   and sign the `.wgt`, install and launch it. Independently observe the
   expected build. Record runtime/user-agent, viewport and last remote key.
   A successful install/launch exit code is not build verification.
8. **Acceptance.** Run fixed remote steps with before/after captures, then the
   separately approved visual model. Retain package/build/task/test
   correlation. Missing, stale, obscured or unreadable frames, unavailable
   inference, invalid JSON, disconnects and timeouts must not pass.
9. **Positive and negative controls.** First retain a real **PASS** for the
   working synthetic build. Deliberately break directional navigation in a
   separately identified synthetic build without changing the trusted harness
   or criteria. Deploy it through the same path and require a real **FAIL**
   for the broken navigation, with fresh evidence identifying that build.
   **INCONCLUSIVE is not a successful negative control**: missing evidence or
   an unavailable model does not demonstrate defect detection. Restore the
   good build and confirm PASS again. Retain each source/build/package identity,
   model audit and private report. Mock tests do not replace this experiment.
10. **Enable unattended operation.** Only after model validation, App/settings
    verification, runner restrictions, camera privacy checks, real positive
    and negative controls, enable the bounded factory experiment. Configure
    environments with branch restrictions; routine approval clicks are not
    part of the intended loop. Keep an independent stop mechanism.

Use `config/device.example.json` as the adapter contract, not as a claim that
the TV has been discovered. Runner labels, target and camera are configurable;
serialize jobs per physical device. Initial tests may assume the TV is on.
Power-on, persistence after a power cycle, device screenshots and native
device automation APIs remain **unverified**. An emulator is optional.

### Public runner registration is a separate security gate

Require workflow approval for **all outside collaborators**, not just first-time
contributors. Review the full workflow diff before ever approving an external
run. Factory-owned PRs use the separately authorized App handoff instead.
Where available, restrict a runner group to the selected trusted device workflow
at the default-branch ref. Check whether the owner's account actually supports
this; organization/enterprise runner-group controls must not be assumed for a
personal repository.

If the platform cannot enforce the required runner provenance, **do not leave a
repository-level LAN runner online**. Keep real execution disabled until an
external, independently trusted runner admission/isolation mechanism is in
place. An approval/attestation variable documents operator validation; setting
it does not implement network or runner isolation. In-file job conditions
cannot protect a runner from a different, malicious workflow requesting its
labels.

## Capability matrix

| Capability | Implemented here | Mock coverage | Still unverified / prerequisite |
| --- | --- | --- | --- |
| Fixture folders, grid, photo, slideshow, focus | Browser application | Synthetic browser/unit scenarios | Physical remote and installed TV runtime |
| Hosted web preview | Master-only, test-gated GitHub Pages workflow | Built project-path browser checks and bounded factory mock | Owner Pages/environment setup and first successful deployment; not real factory activation |
| Build/runtime diagnostics | Bundled diagnostic UI | Build/keyboard checks | Read actual GQ32LS03CBUXZG display |
| Task lifecycle and recovery | Deterministic controller and durable state | Full lifecycle and failure injection | Live App permissions and Actions handoffs |
| Copilot execution | Pinned CLI wrapper, explicit role policy | Model/fallback/override failure cases | Authenticated flagship availability, effort, telemetry and visual approval |
| Independent review and merge | Separate control/worker paths and commit gates | Correlation and fail-closed checks | Live repository protections, App identity and permissions |
| Signed TV installation | SDK/SDB process adapters | Bounded fake device operations | SDK/profile/device permission and actual hardware |
| Private deployment provenance | Local bridge, tested/merged/unsigned/signed identities, exclusive evidence and device locks | Manifest/widget/report rejection and correlation tests | Independently enforced host admission, authenticated receipt transport and physical controls |
| Camera acceptance | Fresh-frame/structured-verdict harness | PASS, FAIL, INCONCLUSIVE scenarios | Real camera, build detector, paired remote and model validation |
| OneDrive authentication/Graph | Provider boundary only | No personal data | Future personal-account delegated read-only implementation |
| Azure, emulator, unattended power-on | Not implemented or required | None | Optional future maintenance work |

## Evidence, privacy and future OneDrive access

Acceptance is structured **PASS / FAIL / INCONCLUSIVE** against fixed criteria.
Only independent, fresh, correlated real-device evidence can satisfy the
delivery gate. The implementer's completion message is not evidence.
Keep raw camera frames, CLI logs, telemetry and device diagnostics private by
default. A public GitHub Actions artifact is not a private evidence store.

Use only synthetic fixtures in public artifacts. Cropping is not automatic
redaction: check reflections, people, account names, notifications, QR codes,
network addresses and identifying room details before publication. Strip
metadata and redact logs before any deliberate public upload. Retain hashes
and verdict summaries where possible, not raw images or prompts.

Real Microsoft authentication is out of scope. Future access must use personal
accounts, delegated read-only permissions and a separate authentication/
Microsoft Graph provider interface. Never log or publish tokens,
preauthenticated download URLs or personal photos. Review device-flow/browser
sign-in support and least-privilege Graph scopes at that milestone.

## Optional Azure extension

Nothing here provisions Azure or needs a separate model-provider API key.
Future infrastructure may use GitHub OIDC, with a federated identity bound to
this exact repository and protected workflow/environment, minimal resource
scope and no subscription-wide role. Verify the actual OIDC subject claims:
new repositories can use immutable owner/repository IDs; do not blindly copy
an older name-based subject. Only the future Azure job needs `id-token: write`.

Use a dedicated resource group, budgets/alerts, expiry tags and automated
teardown. Azure spending/resource lifetime and Copilot inference allowance are
distinct controls; neither is a substitute for the other.

## Instructions for subsequent agents

Preserve the license and existing content. Keep vanilla JavaScript/HTML/CSS
with no mandatory bundler. Keep state, rendering, providers, platform and focus
separate. Use deterministic synthetic fixtures. Extend tests before expanding
acceptance. Do not “fix” a failed app task by changing tests, policy,
permissions, trusted workflow code or device criteria. Factory changes require
the explicit separate maintenance path. Never infer hardware, model or test
success from configured values. Report actual commands, outcomes and remaining
unverified prerequisites.

## Primary references

* [Copilot CLI documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli)
  and [official releases](https://github.com/github/copilot-cli/releases).
* [Contemporaneous CLI telemetry reference](https://github.com/github/docs/blob/a4e23419965182fe7ee23cb207df26087c0279a3/content/copilot/reference/copilot-cli-reference/cli-command-reference.md#opentelemetry-monitoring)
  and [pinned Linux package metadata](https://registry.npmjs.org/@github/copilot-linux-x64/1.0.83);
  neither documentation nor package string tables establish backend identity.
* [Workflow trigger restrictions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
* [GitHub App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
* [Samsung TV developer documentation](https://developer.samsung.com/smarttv/develop)
  and [Tizen command-line interface](https://docs.tizen.org/application/tizen-studio/common-tools/command-line-interface/).
* [GitHub OIDC with Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure).
