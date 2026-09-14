# TzOneDrive
OneDrive for Tizen TV

A vanilla JavaScript, HTML and CSS **synthetic-photo viewer** and a
**Copilot CLI software-factory scaffold**. The MIT license is unchanged.
No OneDrive account, Azure resources, inference credentials or TV are needed
for browser development and the mock lifecycle.

**Real delivery is deliberately disabled until bootstrap.** A mock PASS is
not a physical-TV PASS. No physical TV, camera, signing certificate, Copilot
inference entitlement or live model availability was available during
scaffolding. This PR must be reviewed and merged by the owner, not this factory.
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

## Architecture and boundaries

| Area | Responsibility |
| --- | --- |
| `app/` | Explicit application state, rendering, directional focus, browser/Tizen platform adapters, bounded image loading and mock provider |
| `scripts/` | Local static server, deterministic asset packaging and syntax/workflow guardrails |
| `factory/controller.mjs`, `store.mjs` | Deterministic transitions, intent/receipt persistence, attempts, dependencies and recovery |
| `factory/model-policy.*`, `cli.mjs` | Central role policy and actual non-interactive Copilot CLI invocation |
| `factory/github-*.mjs`, `worker.mjs` | Scoped repository operations, explicit workflow handoffs and independent cloud stages |
| `factory/device.mjs`, `acceptance.mjs`, `adapters/` | Signed deployment, bounded remote/camera steps and strict acceptance evidence |
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
unapproved overrides, native agent delegation and automatic fallback. A model
reporting a different identity, missing required telemetry, or failed inference
does not produce valid review or acceptance evidence.

**Configured is not verified.** Preserve CLI version, requested policy,
catalog evidence, selected ID/effort and any exposed response telemetry
separately. Do not label a configured model as an observed backend model.
No real inference was performed during scaffolding.

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
   independent build detector that reads the displayed full build ID.
   The detector must not echo its expected-build argument.
7. **Diagnostic package.** Build an immutable synthetic-only commit, prepare
   and sign the `.wgt`, install and launch it. Independently observe the
   expected build. Record runtime/user-agent, viewport and last remote key.
   A successful install/launch exit code is not build verification.
8. **Acceptance.** Run fixed remote steps with before/after captures, then the
   separately approved visual model. Retain package/build/task/test
   correlation. Missing, stale, obscured or unreadable frames, unavailable
   inference, invalid JSON, disconnects and timeouts must not pass.
9. **Negative control.** Deliberately break directional navigation in a
   synthetic diagnostic build. Deploy it through the same harness and verify
   a non-PASS verdict. Restore the good build. Mock negative tests do not
   replace this physical experiment.
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
| Build/runtime diagnostics | Bundled diagnostic UI | Build/keyboard checks | Read actual GQ32LS03CBUXZG display |
| Task lifecycle and recovery | Deterministic controller and durable state | Full lifecycle and failure injection | Live App permissions and Actions handoffs |
| Copilot execution | Pinned CLI wrapper, explicit role policy | Model/fallback/override failure cases | Authenticated flagship availability, effort, telemetry and visual approval |
| Independent review and merge | Separate control/worker paths and commit gates | Correlation and fail-closed checks | Live repository protections, App identity and permissions |
| Signed TV installation | SDK/SDB process adapters | Bounded fake device operations | SDK/profile/device permission and actual hardware |
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
* [Workflow trigger restrictions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
* [GitHub App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
* [Samsung TV developer documentation](https://developer.samsung.com/smarttv/develop)
  and [Tizen command-line interface](https://docs.tizen.org/application/tizen-studio/common-tools/command-line-interface/).
* [GitHub OIDC with Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure).
