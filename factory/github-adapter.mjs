import { createHash } from 'node:crypto';
import {
  INFERENCE_ACTIONS, applyEnvironmentBudget, assertBudgetLedger,
  quarantineMissingBudgetLedger, validateTrustedBudget
} from './budget.mjs';
import { GitHubAPI, GitHubContentsLedger, REPOSITORY } from './github-api.mjs';
import { resolvePolicy } from './model-policy.mjs';

const SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
export const assertSha = value => {
  if (!SHA.test(value || '')) throw new Error('Expected an immutable commit SHA');
  return value;
};
export const assertIdentifier = value => {
  if (!IDENTIFIER.test(value || '')) throw new Error('Invalid factory correlation identifier');
  return value;
};

function assertAppIdentity(config) {
  if (config?.repository !== REPOSITORY || config.owner !== 'VasiliyNovikov' ||
      !/^[a-zA-Z0-9_-]+\[bot\]$/.test(config.appBotLogin || '') ||
      !Number.isSafeInteger(config.appId) || config.appId < 1) {
    throw new Error('Trusted repository/App identity has not been configured');
  }
  validateTrustedBudget(config);
}

export function validateEdits(output, limits = {}) {
  const bounds = {
    maxFiles: Math.min(limits.maxFiles ?? 20, 20),
    maxFileBytes: Math.min(limits.maxFileBytes ?? 65536, 65536),
    maxTotalBytes: Math.min(limits.maxTotalBytes ?? 262144, 262144)
  };
  if (!output || !Array.isArray(output.files) || output.files.length < 1 ||
      output.files.length > bounds.maxFiles || Object.keys(output).some(key => !['files', 'summary'].includes(key))) {
    throw new Error('Implementation output must contain a bounded files array');
  }
  const seen = new Set();
  let total = 0;
  return output.files.map(file => {
    if (!file || Object.keys(file).sort().join(',') !== 'content,path' ||
        typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Invalid file edit');
    const segments = file.path.split('/');
    if (!/^app\/[a-zA-Z0-9_./-]+\.(?:js|html|css|svg|json)$/.test(file.path) ||
        segments.some(part => !part || part.startsWith('.') || part === '..' ||
          /^(?:node_modules|tests?|policy|workflows?|config)(?:[._-]|$)/i.test(part) ||
          /^(?:package(?:-lock)?|npm-shrinkwrap)\.json$/i.test(part)) ||
        seen.has(file.path) || file.content.includes('\0')) throw new Error(`Forbidden app edit: ${file.path}`);
    seen.add(file.path);
    const size = Buffer.byteLength(file.content);
    total += size;
    if (size > bounds.maxFileBytes || total > bounds.maxTotalBytes) throw new Error('App edits exceed the content bound');
    return { path: file.path, content: file.content };
  });
}

export function correlation(taskId, stage, key) {
  return `factory:${assertIdentifier(taskId)}:${assertIdentifier(stage)}:${assertIdentifier(key)}`;
}

export function marker(taskId, key) {
  return `<!-- tz-factory task=${assertIdentifier(taskId)} key=${assertIdentifier(key)} -->`;
}

export async function readJSON(api, path, ref, optional = false) {
  try {
    const file = await api.request('GET', `/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (file.encoding !== 'base64' || file.size > 1024 * 1024) throw new Error('Invalid trusted JSON file');
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch (error) {
    if (optional && error.status === 404) return null;
    throw error;
  }
}

export async function defaultHead(api) {
  const repository = await api.request('GET', '');
  if (repository.full_name !== REPOSITORY || !repository.default_branch) throw new Error('Repository identity mismatch');
  const commit = await api.request('GET', `/commits/${encodeURIComponent(repository.default_branch)}`);
  return { branch: repository.default_branch, sha: assertSha(commit.sha) };
}

export async function appSnapshot(api, commitSha) {
  assertSha(commitSha);
  const commit = await api.request('GET', `/git/commits/${commitSha}`);
  const root = await api.request('GET', `/git/trees/${commit.tree.sha}`);
  const app = root.tree.find(entry => entry.path === 'app' && entry.type === 'tree' && entry.mode === '040000');
  if (!app) throw new Error('Candidate lacks an app tree');
  const tree = await api.request('GET', `/git/trees/${app.sha}?recursive=1`);
  if (tree.truncated || tree.tree.length > 200) throw new Error('App snapshot exceeds the tree bound');
  const files = [];
  let total = 0;
  for (const entry of tree.tree) {
    if (entry.type === 'tree') continue;
    if (entry.type !== 'blob' || entry.mode !== '100644' ||
        entry.path.split('/').some(part => !part || part.startsWith('.')) ||
        !/^[a-zA-Z0-9_./-]+$/.test(entry.path) || entry.size > 262144) throw new Error('Unsafe app snapshot file');
    const blob = await api.request('GET', `/git/blobs/${entry.sha}`);
    if (blob.encoding !== 'base64') throw new Error('Invalid app blob encoding');
    const content = Buffer.from(blob.content, 'base64');
    total += content.length;
    if (total > 2 * 1024 * 1024 || content.includes(0)) throw new Error('App snapshot exceeds safe bounds');
    files.push({ path: `app/${entry.path}`, content: content.toString('utf8') });
  }
  return { tree: app.sha, files, rootTree: commit.tree.sha, rootEntries: root.tree };
}

export async function validateCandidate(api, head, base) {
  const [candidate, baseline] = await Promise.all([appSnapshot(api, head), appSnapshot(api, base)]);
  const privileged = snapshot => JSON.stringify(snapshot.rootEntries.filter(entry => entry.path !== 'app')
    .sort((a, b) => a.path.localeCompare(b.path)));
  if (privileged(candidate) !== privileged(baseline)) throw new Error('Candidate modifies files outside app/');
  const old = new Map(baseline.files.map(file => [file.path, file.content]));
  const current = new Map(candidate.files.map(file => [file.path, file.content]));
  if ([...old.keys()].some(path => !current.has(path))) throw new Error('Candidate deletes an app file');
  const changed = candidate.files.filter(file => old.get(file.path) !== file.content);
  if (changed.length) validateEdits({ files: changed });
  return candidate;
}

export class GitHubAdapter {
  constructor({ api, token, config, env = process.env } = {}) {
    this.api = api || new GitHubAPI({ token });
    this.config = config;
    this.env = env;
    this.ledger = new GitHubContentsLedger(this.api);
  }

  async trustedContext() {
    const head = await defaultHead(this.api);
    const config = await readJSON(this.api, 'factory/trusted-config.json', head.sha);
    assertAppIdentity(config);
    return { ...head, config };
  }

  async publishApp({ taskId, key, baseSha, edits }) {
    assertIdentifier(taskId);
    assertIdentifier(key);
    assertSha(baseSha);
    const { branch: defaultBranch, config } = await this.trustedContext();
    const files = validateEdits(edits, config.limits);
    const branch = `factory/${taskId}-${key}`;
    const bodyMarker = marker(taskId, key);
    const previous = await this.api.list(`/pulls?state=all&head=${encodeURIComponent(`VasiliyNovikov:${branch}`)}`);
    if (previous.length) {
      if (previous.length !== 1 || previous[0].number === 1 || previous[0].user?.login !== config.appBotLogin ||
          !previous[0].body?.includes(bodyMarker) || previous[0].base.ref !== defaultBranch) {
        throw new Error('Existing PR does not match the factory identity');
      }
      return { number: previous[0].number, head: previous[0].head.sha, base: previous[0].base.sha, branch };
    }
    const base = await this.api.request('GET', `/git/commits/${baseSha}`);
    const treeEntries = [];
    for (const file of files) {
      const blob = await this.api.request('POST', '/git/blobs', { content: file.content, encoding: 'utf-8' });
      treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const tree = await this.api.request('POST', '/git/trees', { base_tree: base.tree.sha, tree: treeEntries });
    if (tree.sha === base.tree.sha) throw new Error('Implementation produced no app changes');
    const commit = await this.api.request('POST', '/git/commits', {
      message: `Factory app task ${taskId}\n\n${bodyMarker}`, tree: tree.sha, parents: [baseSha]
    });
    try {
      await this.api.request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
    } catch (error) {
      if (error.status !== 422) throw error;
      const existing = await this.api.request('GET', `/git/ref/heads/${branch}`);
      const object = await this.api.request('GET', `/git/commits/${existing.object.sha}`);
      if (object.tree.sha !== tree.sha || object.parents.length !== 1 || object.parents[0].sha !== baseSha ||
          !object.message.includes(bodyMarker)) throw new Error('Factory branch collision');
      commit.sha = existing.object.sha;
    }
    const pr = await this.api.request('POST', '/pulls', {
      title: `Factory: ${taskId}`, head: branch, base: defaultBranch,
      body: `${bodyMarker}\n\nApp-only proposal. Requires independent trusted cloud validation and review before merge.`,
      draft: false
    });
    if (pr.number === 1) throw new Error('Factory may never manage initial PR #1');
    return { number: pr.number, head: commit.sha, base: baseSha, branch };
  }

  async dispatchRun({ taskId, stage, key, head, base, harness }, checkpoint) {
    if (typeof checkpoint !== 'function') throw new Error('Workflow dispatch requires a durable pending checkpoint');
    for (const sha of [head, base, harness]) assertSha(sha);
    const context = await this.trustedContext();
    if (context.sha !== harness) throw new Error('Trusted harness changed before dispatch');
    const workflow = stage === 'deploy' ? 'factory-device.yml' : 'factory-worker.yml';
    const title = correlation(taskId, stage, key);
    const runs = await this.api.list(`/actions/workflows/${workflow}/runs?event=workflow_dispatch&head_sha=${harness}`);
    const matches = runs.filter(run => run.display_title === title && run.head_sha === harness &&
      run.event === 'workflow_dispatch' && run.actor?.login === context.config.appBotLogin);
    if (matches.length > 1) throw new Error('Ambiguous workflow correlation');
    const ticket = { taskId, stage, key, head, base, harness, workflow, runId: matches[0]?.id ?? null };
    // A crash/ambiguous POST after this save permits polling only, never blind redispatch.
    await checkpoint(ticket);
    if (!matches.length) await this.api.request('POST', `/actions/workflows/${workflow}/dispatches`, {
      ref: context.branch, inputs: { task: taskId, stage, key, head, base, harness }
    });
    return ticket;
  }

  async repairApp({ taskId, key, evidence, edits }) {
    const current = await this.trustedContext();
    const previous = evidence.pr;
    if (previous.prNumber <= 1) throw new Error('Forbidden pull request');
    const pr = await this.api.request('GET', `/pulls/${previous.prNumber}`);
    if (pr.merged || pr.state !== 'open' || pr.user?.login !== current.config.appBotLogin ||
        !pr.body?.includes(marker(taskId, previous.publishKey)) || pr.head.ref !== previous.branch) {
      throw new Error('Repair can update only its own unmerged factory PR');
    }
    const oldCommit = await this.api.request('GET', `/git/commits/${pr.head.sha}`);
    if (oldCommit.message.includes(marker(taskId, key))) {
      return { number: pr.number, head: pr.head.sha, base: oldCommit.parents[0].sha,
        branch: pr.head.ref, publishKey: previous.publishKey };
    }
    if (pr.head.sha !== previous.headSha) throw new Error('Repair head changed unexpectedly');
    const [candidate, original] = await Promise.all([
      validateCandidate(this.api, pr.head.sha, evidence.implement.baseSha),
      appSnapshot(this.api, evidence.implement.baseSha)
    ]);
    const originalFiles = new Map(original.files.map(file => [file.path, file.content]));
    const changes = new Map(candidate.files.filter(file => originalFiles.get(file.path) !== file.content)
      .map(file => [file.path, file]));
    for (const file of validateEdits(edits, current.config.limits)) changes.set(file.path, file);
    const files = validateEdits({ files: [...changes.values()] }, current.config.limits);
    const base = await this.api.request('GET', `/git/commits/${current.sha}`);
    const entries = [];
    for (const file of files) {
      const blob = await this.api.request('POST', '/git/blobs', { content: file.content, encoding: 'utf-8' });
      entries.push({ path: file.path, type: 'blob', mode: '100644', sha: blob.sha });
    }
    const tree = await this.api.request('POST', '/git/trees', { base_tree: base.tree.sha, tree: entries });
    const commit = await this.api.request('POST', '/git/commits', {
      message: `Factory repair ${taskId}\n\n${marker(taskId, key)}`,
      tree: tree.sha, parents: [current.sha, pr.head.sha]
    });
    await this.api.request('PATCH', `/git/refs/heads/${pr.head.ref}`, { sha: commit.sha, force: false });
    return { number: pr.number, head: commit.sha, base: current.sha, branch: pr.head.ref, publishKey: previous.publishKey };
  }

  async pollRun(ticket) {
    const context = await this.trustedContext();
    const runs = ticket.runId
      ? [await this.api.request('GET', `/actions/runs/${ticket.runId}`)]
      : await this.api.list(`/actions/workflows/${ticket.workflow}/runs?event=workflow_dispatch&head_sha=${ticket.harness}`);
    const matches = runs.filter(run => run.display_title === correlation(ticket.taskId, ticket.stage, ticket.key) &&
      run.head_sha === ticket.harness && run.event === 'workflow_dispatch' &&
      run.actor?.login === context.config.appBotLogin &&
      run.path?.split('@')[0] === `.github/workflows/${ticket.workflow}`);
    if (matches.length > 1) throw new Error('Ambiguous workflow correlation');
    if (!matches.length || matches[0].status !== 'completed') return { status: 'pending' };
    const run = matches[0];
    if (run.conclusion !== 'success') return { status: 'failed', reason: `Workflow ${run.id}: ${run.conclusion}` };
    const artifacts = await this.api.list(`/actions/runs/${run.id}/artifacts`);
    const output = artifacts.filter(artifact => artifact.name === `factory-result-${ticket.key}` &&
      !artifact.expired && artifact.workflow_run?.id === run.id);
    if (output.length !== 1) return { status: 'failed', reason: 'Missing or ambiguous result artifact' };
    const result = await this.api.downloadResult(output[0].id);
    if (result.taskId !== ticket.taskId || result.stage !== ticket.stage || result.key !== ticket.key ||
        result.head !== ticket.head || result.base !== ticket.base || result.harness !== ticket.harness) {
      throw new Error('Workflow result identity mismatch');
    }
    return { status: 'completed', result, runId: run.id, artifactId: output[0].id };
  }

  async mergePR({ taskId, key, number, head, base }) {
    if (!Number.isSafeInteger(number) || number <= 1) throw new Error('Forbidden pull request');
    assertSha(head);
    assertSha(base);
    const current = await this.trustedContext();
    const pr = await this.api.request('GET', `/pulls/${number}`);
    if (pr.user?.login !== current.config.appBotLogin || !pr.body?.includes(marker(taskId, key)) ||
        pr.head.repo?.full_name !== REPOSITORY || pr.base.ref !== current.branch || pr.head.sha !== head) {
      throw new Error('Pull request identity/head mismatch');
    }
    if (!pr.merged && (current.sha !== base || pr.base.sha !== base)) return { merged: false, stale: true };
    const commit = await this.api.request('GET', `/git/commits/${head}`);
    let mergeSha = pr.merged ? assertSha(pr.merge_commit_sha) : null;
    if (!pr.merged) {
      if (![1, 2].includes(commit.parents.length) || commit.parents[0].sha !== base) throw new Error('Candidate is not based on the tested default head');
      await validateCandidate(this.api, head, base);
      const result = await this.api.request('PUT', `/pulls/${number}/merge`, {
        sha: head, merge_method: 'merge', commit_title: `Factory accepted app task ${taskId}`
      });
      if (!result.merged) throw new Error('GitHub refused the exact tested head merge');
      mergeSha = assertSha(result.sha);
    }
    const merged = await this.api.request('GET', `/git/commits/${mergeSha}`);
    if (merged.tree.sha !== commit.tree.sha) throw new Error('Merged tree differs from the tested tree; deployment forbidden');
    return { merged: true, sha: mergeSha };
  }
}

export const contentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const wireKey = value => contentHash(value).slice(0, 32);

export function isEnabled(config, env = process.env) {
  return config.enabled === true && config.stop === false &&
    env.FACTORY_ENABLED === 'true' && env.FACTORY_STOP !== 'true';
}

function assertWorkflowContext(current, workflow, env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_SHA !== current.sha ||
      env.GITHUB_REF !== `refs/heads/${current.branch}` ||
      env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/${workflow}@refs/heads/${current.branch}`) {
    throw new Error('Workflow must execute the current trusted default-branch harness');
  }
}

export async function authorizeController(api, env = process.env) {
  const current = await defaultHead(api);
  assertWorkflowContext(current, 'factory-controller.yml', env);
  const config = await readJSON(api, 'factory/trusted-config.json', current.sha);
  assertAppIdentity(config);
  const effectiveConfig = applyEnvironmentBudget(config, env);
  if (String(config.appId) !== env.FACTORY_APP_ID ||
      !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      (env.GITHUB_EVENT_NAME === 'schedule' && env.FACTORY_SCHEDULE_ENABLED !== 'true') ||
      (env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
        (env.GITHUB_ACTOR !== config.owner || env.GITHUB_TRIGGERING_ACTOR !== config.owner))) {
    throw new Error('Only owner dispatch or the opt-in trusted default-branch schedule can run the controller');
  }
  return { ...current, config: effectiveConfig };
}

export async function authorizeDispatch(api, inputs, env = process.env) {
  if (!inputs || Object.keys(inputs).sort().join(',') !== 'base,harness,head,key,stage,task') {
    throw new Error('Dispatch requires exactly task/stage/key/head/base/harness');
  }
  for (const value of [inputs.head, inputs.base, inputs.harness]) assertSha(value);
  correlation(inputs.task, inputs.stage, inputs.key);
  const current = await defaultHead(api);
  const workflow = inputs.stage === 'deploy' ? 'factory-device.yml' : 'factory-worker.yml';
  assertWorkflowContext(current, workflow, env);
  if (current.sha !== inputs.harness || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Dispatch must use the current trusted default branch');
  }
  const config = await readJSON(api, 'factory/trusted-config.json', current.sha);
  assertAppIdentity(config);
  if (!isEnabled(config, env) || env.GITHUB_ACTOR !== config.appBotLogin ||
      env.GITHUB_TRIGGERING_ACTOR !== config.appBotLogin ||
      String(config.appId) !== env.FACTORY_APP_ID) throw new Error('Dispatch is stopped or not authorized by the installed App');
  const { state } = await new GitHubContentsLedger(api).read();
  const { assertState, validationGate } = await import('./controller.mjs');
  assertState(state);
  const task = state?.tasks?.find(item => item.id === inputs.task);
  if (state?.mode !== 'real' || state.simulated !== false || state.activeTaskId !== inputs.task ||
      !['running', 'waiting'].includes(state.status) || !['running', 'waiting'].includes(task?.status) ||
      task.stage !== inputs.stage || task.intent?.action !== inputs.stage ||
      wireKey(task.intent?.key) !== inputs.key || Date.now() >= state.expiresAt) {
    throw new Error('Dispatch does not match the current durable task intent');
  }
  const pending = task.intent.pending?.ticket;
  if (pending && (['head', 'base', 'harness', 'key', 'stage'].some(field => pending[field] !== inputs[field]) ||
      pending.taskId !== inputs.task || pending.workflow !== workflow)) {
    throw new Error('Dispatch disagrees with its persisted workflow ticket');
  }
  if (INFERENCE_ACTIONS.includes(inputs.stage)) {
    assertBudgetLedger(state.budget);
    const reservation = state.budget.reservations[task.intent.key];
    if (!reservation || reservation.status !== 'reserved' || reservation.action !== inputs.stage ||
        reservation.taskId !== inputs.task || reservation.runId !== state.runId) {
      throw new Error('Dispatch lacks a durable inference budget reservation');
    }
  }
  if (['plan', 'implement'].includes(inputs.stage) &&
      (inputs.head !== current.sha || inputs.base !== current.sha)) throw new Error('Implementation snapshot is not current');
  if (['validate', 'repair'].includes(inputs.stage) &&
      (inputs.head !== task.evidence.pr?.headSha || inputs.base !== task.evidence.implement?.baseSha)) {
    throw new Error('Dispatch is not for the tracked candidate');
  }
  if (inputs.stage === 'deploy') {
    if (task.evidence.merge?.merged !== true || inputs.head !== task.evidence.merge.mergeSha ||
        inputs.base !== inputs.head || current.sha !== inputs.head ||
        validationGate(task, 'real') || task.evidence.merge.headSha !== task.evidence.validate.testedSha) {
      throw new Error('Only the independently validated merged default commit can reach the LAN');
    }
    const pr = await api.request('GET', `/pulls/${task.evidence.pr.prNumber}`);
    if (pr.number !== task.evidence.pr.prNumber || pr.number <= 1 || pr.merged !== true || pr.merge_commit_sha !== inputs.head ||
        pr.head.sha !== task.evidence.validate.testedSha || pr.user?.login !== config.appBotLogin ||
        pr.head.repo?.full_name !== REPOSITORY || pr.base?.ref !== current.branch ||
        !pr.body?.includes(marker(task.id, task.evidence.pr.publishKey))) {
      throw new Error('Merged PR provenance mismatch');
    }
    const commits = await Promise.all([task.evidence.validate.testedSha, inputs.head]
      .map(sha => api.request('GET', `/git/commits/${sha}`)));
    const sourceTrees = commits.map(commit => assertSha(commit.tree?.sha));
    if (sourceTrees[0] !== sourceTrees[1]) throw new Error('Tested and merged source trees differ');
    return { ...inputs, task, state, config, sourceTrees };
  } else if (!['plan', 'implement', 'repair', 'validate'].includes(inputs.stage)) {
    throw new Error('Unsupported dispatch stage');
  }
  return { ...inputs, task, state, config };
}

export async function createAdapter(options = {}) {
  const adapter = new GitHubAdapter({ token: options.token ?? process.env.FACTORY_GITHUB_TOKEN, ...options });
  adapter.execute = async (action, task, context) => {
    const key = wireKey(context.idempotencyKey);
    const pass = fields => ({ verdict: 'PASS', simulated: false, ...fields });
    if (action === 'pr') {
      const result = context.evidence.implement;
      return pass({ prNumber: result.prNumber, headSha: result.headSha, baseSha: result.baseSha,
        publishKey: result.publishKey, branch: result.branch });
    }
    if (action === 'merge') {
      const result = await adapter.mergePR({
        taskId: task.id, key: context.evidence.pr.publishKey, number: context.evidence.pr.prNumber,
        head: context.evidence.validate.testedSha, base: context.evidence.implement.baseSha
      });
      if (!result.merged) return { verdict: 'FAIL', simulated: false, stale: true, reason: 'Default branch advanced; candidate must be rebuilt and reviewed' };
      return pass({ merged: true, headSha: context.evidence.validate.testedSha, mergeSha: result.sha });
    }
    if (action === 'accept') {
      return { verdict: 'INCONCLUSIVE', simulated: false, reasonCode: 'PRIVATE_DEVICE_TRANSPORT_REQUIRED' };
    }
    const trusted = await adapter.trustedContext();
    if (!isEnabled(trusted.config, adapter.env)) throw new Error('Factory stopped');
    const base = ['validate', 'repair'].includes(action) ? context.evidence.implement.baseSha : trusted.sha;
    const head = ['validate', 'repair'].includes(action) ? context.evidence.pr.headSha :
      action === 'deploy' ? context.evidence.merge.mergeSha : trusted.sha;
    const pending = ticket => ({ pending: true, simulated: false, nextPollAt: context.now + 60000, ticket });
    const ticket = context.previousReceipt?.ticket ?? await adapter.dispatchRun({
      taskId: task.id, stage: action, key, head, base: action === 'deploy' ? head : base, harness: trusted.sha
    }, ticket => context.checkpointPending(pending(ticket)));
    const polled = await adapter.pollRun(ticket);
    if (polled.status === 'pending') return pending(ticket);
    if (polled.status === 'failed') return { verdict: 'FAIL', simulated: false, reason: polled.reason };
    const result = polled.result;
    if (['implement', 'repair'].includes(action)) {
      if (result.error) return { verdict: 'FAIL', simulated: false, reason: result.error };
      const published = action === 'repair'
        ? await adapter.repairApp({ taskId: task.id, key, evidence: context.evidence, edits: result.edits })
        : await adapter.publishApp({ taskId: task.id, key, baseSha: ticket.base, edits: result.edits });
      return pass({ headSha: published.head, baseSha: published.base, prNumber: published.number,
        branch: published.branch, publishKey: published.publishKey ?? key,
        inferenceBilling: result.inferenceBilling });
    }
    if (action === 'validate') {
      if (result.ciPassed !== true || result.review?.verdict !== 'PASS') {
        return { verdict: 'FAIL', simulated: false, reason: 'Independent trusted validation/review did not pass' };
      }
      return pass({ headSha: ticket.head, testedSha: ticket.head, baseSha: ticket.base,
        ciPassed: true, independentReview: { verdict: 'PASS', independent: true, reviewer: 'Claude Opus 5', audit: result.review.audit },
        package: result.package, inferenceBilling: result.inferenceBilling ?? result.review.inferenceBilling });
    }
    if (action === 'plan') {
      if (typeof result.plan !== 'string' || !result.plan.trim() || result.plan.length > 16000) throw new Error('Invalid planning output');
      return pass({ plan: result.plan, baseSha: ticket.base, inferenceBilling: result.inferenceBilling });
    }
    // Public workflow artifacts are not an authenticated private evidence transport.
    if (action === 'deploy') return { verdict: 'INCONCLUSIVE', simulated: false,
      reasonCode: 'PRIVATE_DEVICE_TRANSPORT_REQUIRED' };
    throw new Error('Unsupported production action');
  };
  return adapter;
}

export async function runProduction({ env = process.env, api } = {}) {
  const { createState, assertState, runLoop } = await import('./controller.mjs');
  api ??= new GitHubAPI({ token: env.FACTORY_GITHUB_TOKEN });
  const current = await authorizeController(api, env);
  const { config } = current;
  const ledger = new GitHubContentsLedger(api);
  let { version, state } = await ledger.read();
  const persist = async value => {
    const next = await ledger.compareAndSwap(version, value);
    if (!next) throw new Error('Concurrent ledger modification; no side effect may continue');
    version = next;
  };
  if (!state) state = createState(config.backlog, { mode: 'real' });
  else if (quarantineMissingBudgetLedger(state, config, Date.now())) await persist(state);
  assertState(state);
  if (state.mode !== 'real') throw new Error('Production ledger cannot contain simulated state');
  if (!isEnabled(config, env)) {
    state.status = 'stopped';
    await persist(state);
    return state;
  }
  try {
    const [policy, catalog] = await Promise.all([
      readJSON(api, 'factory/model-policy.json', current.sha),
      readJSON(api, 'factory/model-catalog.json', current.sha, true)
    ]);
    resolvePolicy(policy, catalog, { runId: state.runId });
  } catch (error) {
    state.status = 'blocked';
    for (const task of state.tasks.filter(item => !['blocked', 'delivered'].includes(item.status))) {
      task.status = 'blocked';
      task.blockedReason = `model-prerequisite:${error.code ?? error.message}`;
    }
    state.activeTaskId = null;
    await persist(state);
    return state;
  }
  const adapter = await createAdapter({ api, config, env });
  state = await runLoop(state, adapter, {
    persist, stop: async () => !isEnabled(await readJSON(api, 'factory/trusted-config.json', (await defaultHead(api)).sha), env)
  });
  return state;
}
