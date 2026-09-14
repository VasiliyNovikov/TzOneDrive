import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { GitHubAPI, GitHubContentsLedger, GitHubError, extractResult } from '../factory/github-api.mjs';
import {
  GitHubAdapter, validateEdits, correlation, defaultHead, marker,
  authorizeController, authorizeDispatch, isEnabled, runProduction, wireKey
} from '../factory/github-adapter.mjs';
import { createState } from '../factory/controller.mjs';
import {
  blockedDeviceReceipt, childEnvironment, combineResults, dispatchInputs,
  inferenceAudit, parseReview, runWorker, serializeResult
} from '../factory/worker.mjs';

const sha = 'a'.repeat(40);
const config = {
  repository: 'VasiliyNovikov/TzOneDrive', owner: 'VasiliyNovikov',
  appBotLogin: 'fixture-factory[bot]', appId: 123
};
const jsonFile = value => ({
  encoding: 'base64', size: 100, content: Buffer.from(JSON.stringify(value)).toString('base64')
});

test('GitHub client confines authenticated requests and disables redirects', async () => {
  const calls = [];
  const api = new GitHubAPI({ token: 'test-only', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ default_branch: 'master' }) };
  } });
  await api.request('GET', '');
  assert.equal(calls[0].url, 'https://api.github.com/repos/VasiliyNovikov/TzOneDrive');
  assert.equal(calls[0].options.redirect, 'error');
  for (const path of ['https://evil.invalid', '//evil.invalid', '/../installation', '/contents/%2e%2e/secret', '/a\\b']) {
    await assert.rejects(api.request('GET', path), /Invalid repository API path/);
  }
  assert.throws(() => new GitHubAPI({ token: 'test-only', repository: 'other/repo' }), /restricted/);
});

test('default branch is discovered rather than assumed main', async () => {
  const paths = [];
  const result = await defaultHead({ request: async (_method, path) => {
    paths.push(path);
    return path === '' ? { full_name: config.repository, default_branch: 'master' } : { sha };
  } });
  assert.deepEqual(result, { branch: 'master', sha });
  assert.deepEqual(paths, ['', '/commits/master']);
});

test('publisher accepts only bounded app text edits, never privileged/config files', () => {
  const accepted = { files: [{ path: 'app/src/view.js', content: 'export const title = "TV";' }] };
  assert.deepEqual(validateEdits(accepted), accepted.files);
  for (const path of [
    '.github/workflows/ci.yml', 'factory/policy.json', 'app/../factory/a.js', 'app/.hidden/a.js',
    'app//a.js', 'app/config.xml', 'app/config.json', 'app/tests/check.js', 'app/package.json',
    'app/node_modules/dep.js', 'app/evil%2f.js', 'app/a.mjs', 'app/a.js/../b.js'
  ]) {
    assert.throws(() => validateEdits({ files: [{ path, content: 'x' }] }), /Forbidden/);
  }
  assert.throws(() => validateEdits({ files: [{ path: 'app/a.js', content: 'x'.repeat(65537) }] }), /bound/);
  assert.throws(() => validateEdits({ files: [accepted.files[0], accepted.files[0]] }), /Forbidden/);
  assert.throws(() => validateEdits({ files: accepted.files, verdict: 'pass' }), /bounded/);
  assert.throws(() => correlation('task\nbad', 'test', 'key'), /identifier/);
});

test('ledger writes use contents SHA compare-and-swap and preserve conflicts', async () => {
  const calls = [];
  const api = { request: async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return { ...jsonFile({ tasks: [] }), sha: 'ledger-v1' };
    if (body.sha === 'stale') throw new GitHubError(409, 'Conflict');
    return { content: { sha: 'ledger-v2' } };
  } };
  const ledger = new GitHubContentsLedger(api);
  assert.deepEqual(await ledger.read(), { version: 'ledger-v1', state: { tasks: [] } });
  assert.equal(await ledger.compareAndSwap('ledger-v1', { tasks: ['next'] }), 'ledger-v2');
  assert.equal(calls[1].body.sha, 'ledger-v1');
  assert.equal(calls[1].body.branch, 'factory-ledger');
  assert.equal(await ledger.compareAndSwap('stale', {}), false);
});

function artifactJSON(value, { streaming = false, deflate = false } = {}) {
  const data = Buffer.from(JSON.stringify(value));
  const compressed = deflate ? deflateRawSync(data) : data;
  const name = Buffer.from('result.json');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(streaming ? 8 : 0, 6);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(streaming ? 0 : compressed.length, 18);
  local.writeUInt32LE(streaming ? 0 : data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const descriptor = Buffer.alloc(streaming ? 16 : 0);
  if (streaming) {
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(data.length, 12);
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(streaming ? 8 : 0, 8);
  central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length + descriptor.length, 16);
  return Buffer.concat([local, name, compressed, descriptor, central, name, end]);
}

test('artifact parser accepts only a single bounded result.json without extraction', () => {
  assert.deepEqual(JSON.parse(extractResult(artifactJSON({ ok: true }))), { ok: true });
  for (const deflate of [false, true]) {
    assert.deepEqual(JSON.parse(extractResult(artifactJSON({ ok: true }, { streaming: true, deflate }))), { ok: true });
  }
  assert.throws(() => extractResult(Buffer.from('not zip')), /Invalid/);
  const zip = artifactJSON({ ok: true });
  zip.writeUInt16LE(2, zip.length - 12);
  assert.throws(() => extractResult(zip), /Invalid/);
});

test('artifact signed download never forwards repository authorization', async () => {
  const calls = [];
  const archive = artifactJSON({ status: 'pass' });
  const api = new GitHubAPI({ token: 'test-only', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(null, {
      status: 302, headers: { location: 'https://productionresultssa1.blob.core.windows.net/results/signed' }
    });
    return new Response(archive);
  } });
  assert.deepEqual(await api.downloadResult(42), { status: 'pass' });
  assert.equal(calls[1].options.headers, undefined);
  const evil = new GitHubAPI({ token: 'test-only', fetchImpl: async () => new Response(null, {
    status: 302, headers: { location: 'https://evil.invalid/artifact' }
  }) });
  await assert.rejects(evil.downloadResult(42), /Untrusted/);
});

test('polling never selects a latest run or mismatched artifact identity', async () => {
  const ticket = { taskId: 'one', stage: 'validate', key: 'key', head: sha, base: sha, harness: sha, workflow: 'factory-worker.yml' };
  const run = {
    id: 5, display_title: correlation('one', 'validate', 'key'), head_sha: sha,
    event: 'workflow_dispatch', actor: { login: config.appBotLogin }, path: '.github/workflows/factory-worker.yml',
    status: 'completed', conclusion: 'success'
  };
  const api = {
    request: async (_method, path) => path === '' ? { full_name: config.repository, default_branch: 'master' } :
      path === '/commits/master' ? { sha } : jsonFile(config),
    list: async path => path.includes('/artifacts')
      ? [{ id: 10, name: 'factory-result-key', expired: false, workflow_run: { id: 5 } }]
      : [{ ...run, id: 6, display_title: 'another task' }, run],
    downloadResult: async () => ({ ...ticket, taskId: 'other' })
  };
  const adapter = new GitHubAdapter({ api });
  await assert.rejects(adapter.pollRun(ticket), /identity mismatch/);
  api.downloadResult = async () => ({ ...ticket, ok: true });
  assert.equal((await adapter.pollRun(ticket)).runId, 5);
  api.list = async () => [run, run];
  await assert.rejects(adapter.pollRun(ticket), /Ambiguous/);
});

test('the factory never manages PR #1 or a marker-free PR', async () => {
  const adapter = new GitHubAdapter({ api: {} });
  await assert.rejects(adapter.mergePR({ number: 1, head: sha, base: sha }), /Forbidden/);
  assert.equal(marker('one', 'key'), '<!-- tz-factory task=one key=key -->');
});

function dispatchFixture(stage = 'plan') {
  const configured = { ...config, enabled: true, stop: false };
  const state = createState([{ id: 'one', goal: 'Trusted synthetic goal' }], { mode: 'real', now: Date.now() });
  const task = state.tasks[0];
  task.status = 'running';
  task.stage = stage;
  task.intent = { action: stage, key: `intent-${stage}` };
  state.activeTaskId = task.id;
  const candidate = 'b'.repeat(40);
  task.evidence.implement = { headSha: candidate, baseSha: sha };
  task.evidence.pr = { prNumber: 42, headSha: candidate };
  task.evidence.validate = { verdict: 'PASS', testedSha: candidate };
  task.evidence.merge = { merged: true, mergeSha: sha };
  const inputs = {
    task: task.id, stage, key: wireKey(task.intent.key),
    head: ['validate', 'repair'].includes(stage) ? candidate : sha, base: sha, harness: sha
  };
  const workflow = stage === 'deploy' ? 'factory-device.yml' : 'factory-worker.yml';
  const env = {
    GITHUB_REPOSITORY: config.repository, GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/master', GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/${workflow}@refs/heads/master`,
    GITHUB_ACTOR: config.appBotLogin, GITHUB_TRIGGERING_ACTOR: config.appBotLogin,
    FACTORY_ENABLED: 'true', FACTORY_STOP: 'false', FACTORY_APP_ID: String(config.appId),
    ...Object.fromEntries(Object.entries(inputs).map(([key, value]) => [`FACTORY_${key.toUpperCase()}`, value]))
  };
  const pr = { number: 42, merged: true, merge_commit_sha: sha,
    head: { sha: candidate }, user: { login: config.appBotLogin } };
  const writes = [];
  const api = { request: async (method, path, body) => {
    if (method !== 'GET') {
      writes.push({ method, path, body });
      assert.equal(method, 'PUT', 'Authorization must never dispatch work');
      assert.equal(path, '/contents/ledger.json');
      return { content: { sha: 'next-ledger-version' } };
    }
    if (path === '') return { full_name: config.repository, default_branch: 'master' };
    if (path === '/commits/master') return { sha };
    if (path === `/contents/factory/trusted-config.json?ref=${sha}`) return jsonFile(configured);
    if (path === '/contents/ledger.json?ref=factory-ledger') return { ...jsonFile(state), sha: 'ledger-version' };
    if (path === '/pulls/42') return pr;
    if (path === `/contents/factory/model-policy.json?ref=${sha}`) {
      return jsonFile(JSON.parse(await readFile(new URL('../factory/model-policy.json', import.meta.url))));
    }
    if (path === `/contents/factory/model-catalog.json?ref=${sha}`) throw new GitHubError(404, 'Missing catalog');
    throw new Error(`Unexpected test API read: ${path}`);
  } };
  return { api, inputs, env, configured, state, task, pr, writes, workflow };
}

test('all dispatched stages require exact inputs, App identity and the durable intent', async () => {
  for (const stage of ['plan', 'implement', 'repair', 'validate', 'deploy']) {
    const fixture = dispatchFixture(stage);
    const { api, inputs, env, task, workflow, writes } = fixture;
    assert.deepEqual(dispatchInputs(env), inputs);
    assert.equal((await authorizeDispatch(api, inputs, env)).task.id, task.id);
    task.intent.pending = { ticket: { ...inputs, taskId: inputs.task, workflow } };
    await authorizeDispatch(api, inputs, env);
    task.intent.pending.ticket.head = 'c'.repeat(40);
    await assert.rejects(authorizeDispatch(api, inputs, env), /persisted workflow ticket/);
    assert.deepEqual(writes, []);
  }
  const { api, inputs, env } = dispatchFixture();
  await assert.rejects(authorizeDispatch(api, { ...inputs, command: 'not-allowed' }, env), /exactly/);
});

test('adapter dispatch names, input keys and default ref match the workflow handoff exactly', async () => {
  for (const stage of ['plan', 'implement', 'repair', 'validate', 'deploy']) {
    const { api, inputs, workflow } = dispatchFixture(stage);
    const calls = [];
    const remote = {
      list: async () => [],
      request: async (method, path, body) => {
        if (method === 'POST') { calls.push({ path, body }); return null; }
        return api.request(method, path, body);
      }
    };
    const adapter = new GitHubAdapter({ api: remote });
    const ticket = await adapter.dispatchRun({ ...inputs, taskId: inputs.task });
    assert.equal(ticket.workflow, workflow);
    assert.deepEqual(calls, [{
      path: `/actions/workflows/${workflow}/dispatches`, body: { ref: 'master', inputs }
    }]);
    remote.list = async () => [{
      id: 123, head_sha: sha, event: 'workflow_dispatch',
      display_title: correlation(inputs.task, stage, inputs.key), actor: { login: config.appBotLogin }
    }];
    assert.equal((await adapter.dispatchRun({ ...inputs, taskId: inputs.task })).runId, 123);
    assert.equal(calls.length, 1, 'A persisted intent must not dispatch a duplicate run');
  }
});

test('dispatch denies public actors, foreign/stale harnesses, reruns by humans and stop overrides', async () => {
  for (const override of [
    { GITHUB_ACTOR: 'outside-user' }, { GITHUB_TRIGGERING_ACTOR: config.owner },
    { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/other.yml@refs/heads/master` },
    { FACTORY_APP_ID: '999' }, { FACTORY_ENABLED: 'false' }, { FACTORY_STOP: 'true' }
  ]) {
    const { api, inputs, env, writes } = dispatchFixture();
    await assert.rejects(authorizeDispatch(api, inputs, { ...env, ...override }));
    assert.deepEqual(writes, []);
  }
  for (const override of [
    { enabled: false }, { stop: true }, { owner: 'other' },
    { appBotLogin: config.owner }, { appId: '123' }
  ]) {
    const { api, inputs, env, configured } = dispatchFixture();
    Object.assign(configured, override);
    await assert.rejects(authorizeDispatch(api, inputs, env));
  }
});

test('dispatch cannot use stale, simulated, expired or substituted task state', async () => {
  for (const mutate of [
    ({ state }) => { state.mode = state.originMode = 'mock'; state.simulated = true; },
    ({ state }) => { state.status = 'stopped'; },
    ({ state }) => {
      state.createdAt = Date.now() - state.limits.experimentMs - 100;
      state.expiresAt = state.createdAt + state.limits.experimentMs;
    },
    ({ task }) => { task.intent = null; },
    ({ task }) => { task.intent.key = 'superseded'; },
    ({ task }) => { task.goal = 'Unapproved replacement goal'; },
    ({ inputs }) => { inputs.task = 'other'; },
    ({ inputs }) => { inputs.stage = 'implement'; },
    ({ inputs }) => { inputs.harness = 'b'.repeat(40); },
    ({ inputs }) => { inputs.head = 'b'.repeat(40); },
    ({ inputs }) => { inputs.base = 'b'.repeat(40); }
  ]) {
    const fixture = dispatchFixture();
    mutate(fixture);
    await assert.rejects(authorizeDispatch(fixture.api, fixture.inputs, fixture.env));
  }
  for (const stage of ['validate', 'repair']) {
    const { api, inputs, env } = dispatchFixture(stage);
    await assert.rejects(authorizeDispatch(api, { ...inputs, head: sha }, env), /tracked candidate/);
    await assert.rejects(authorizeDispatch(api, { ...inputs, base: 'c'.repeat(40) }, env), /tracked candidate/);
  }
});

test('device authorization rejects unmerged, unreviewed or unrelated physical handoffs', async () => {
  for (const mutate of [
    ({ task }) => { task.evidence.merge.merged = false; },
    ({ task }) => { task.evidence.validate.verdict = 'FAIL'; },
    ({ pr }) => { pr.merged = false; },
    ({ pr }) => { pr.number = 1; },
    ({ pr }) => { pr.merge_commit_sha = 'c'.repeat(40); },
    ({ pr }) => { pr.head.sha = 'c'.repeat(40); },
    ({ pr }) => { pr.user.login = 'other'; },
    ({ inputs }) => { inputs.base = 'c'.repeat(40); }
  ]) {
    const fixture = dispatchFixture('deploy');
    mutate(fixture);
    await assert.rejects(authorizeDispatch(fixture.api, fixture.inputs, fixture.env));
  }
});

function controllerFixture() {
  const fixture = dispatchFixture();
  fixture.env.GITHUB_ACTOR = fixture.env.GITHUB_TRIGGERING_ACTOR = config.owner;
  fixture.env.GITHUB_WORKFLOW_REF = `${config.repository}/.github/workflows/factory-controller.yml@refs/heads/master`;
  return fixture;
}

test('controller authorizes only the current owner harness or explicitly opted-in schedule', async () => {
  const { api, env } = controllerFixture();
  await authorizeController(api, env);
  await assert.rejects(authorizeController(api, { ...env, GITHUB_ACTOR: config.appBotLogin }), /Only owner/);
  await assert.rejects(authorizeController(api, { ...env, GITHUB_TRIGGERING_ACTOR: 'other' }), /Only owner/);
  await assert.rejects(authorizeController(api, { ...env, GITHUB_SHA: 'c'.repeat(40) }), /harness/);
  const schedule = { ...env, GITHUB_EVENT_NAME: 'schedule' };
  await assert.rejects(authorizeController(api, schedule), /opt-in/);
  await authorizeController(api, { ...schedule, FACTORY_SCHEDULE_ENABLED: 'true' });
});

test('production persists stopped or model-blocked state without any remote work', async () => {
  const stopped = controllerFixture();
  stopped.configured.enabled = false;
  stopped.configured.stop = true;
  assert.equal(isEnabled(stopped.configured, stopped.env), false);
  const stoppedState = await runProduction({ api: stopped.api, env: stopped.env });
  assert.equal(stoppedState.status, 'stopped');
  assert.equal(stopped.writes.length, 1);
  assert.equal(JSON.parse(Buffer.from(stopped.writes[0].body.content, 'base64')).status, 'stopped');

  const blocked = controllerFixture();
  const blockedState = await runProduction({ api: blocked.api, env: blocked.env });
  assert.equal(blockedState.status, 'blocked');
  assert.match(blockedState.tasks[0].blockedReason, /^model-prerequisite:/);
  assert.equal(blocked.writes.length, 1);
});

test('gate and combine reauthorize before consuming any artifact or performing work', async () => {
  const { api, env } = dispatchFixture('validate');
  assert.equal((await runWorker('gate', { api, env })).stage, 'validate');
  await assert.rejects(runWorker('combine', { api, env: { ...env, GITHUB_ACTOR: 'outside-user' } }), /not authorized/);
});

test('parallel results bind every identity field and preserve independent review failures', () => {
  const identity = { taskId: 'one', stage: 'validate', key: 'key', head: sha, base: sha, harness: sha };
  const tests = { ...identity, ciPassed: true, package: { headSha: sha, buildId: sha, sha256: 'b'.repeat(64) } };
  const review = { ...identity, review: { verdict: 'PASS', findings: [], audit: { role: 'review' } } };
  assert.equal(combineResults(identity, tests, review).ciPassed, true);
  for (const field of Object.keys(identity)) {
    assert.throws(() => combineResults(identity, { ...tests, [field]: 'other' }, review), /identity/);
    assert.throws(() => combineResults(identity, tests, { ...review, [field]: 'other' }), /identity/);
  }
  assert.throws(() => combineResults(identity, { ...tests, ciPassed: false }, review), /browser package/);
  assert.throws(() => combineResults(identity, { ...tests, package: { ...tests.package, buildId: 'other' } }, review), /browser package/);
  const failed = { ...review, review: { verdict: 'FAIL', findings: ['Broken Back navigation'] } };
  assert.equal(combineResults(identity, tests, failed).review.verdict, 'FAIL');
  assert.throws(() => combineResults(identity, tests, { ...review, review: { verdict: 'PASS', findings: ['broken'] } }), /strict verdict/);
  assert.throws(() => parseReview('private raw model output'), error => !error.message.includes('private raw model output'));
});

test('artifact bound accounts for JSON escaping and remains compatible with the ZIP reader', () => {
  const identity = { taskId: 'one', stage: 'deploy', key: 'key', head: sha, base: sha, harness: sha };
  const result = blockedDeviceReceipt(identity);
  assert.deepEqual(JSON.parse(serializeResult(result)), result);
  assert.deepEqual(JSON.parse(extractResult(artifactJSON(result))), result);
  assert.equal(result.receipt.verdict, 'INCONCLUSIVE');
  assert.equal(result.receipt.simulated, false);
  assert.equal(result.receipt.installed, false);
  assert.equal(result.receipt.launched, false);
  assert.equal(result.receipt.gateEligible, false);
  assert.equal(result.receipt.reasonCode, 'DEVICE_BOOTSTRAP_REQUIRED');
  assert.throws(() => serializeResult({ text: '\u0001'.repeat(65536) }), /artifact size bound/);
});

test('browser process sees only a clean environment and tests the built candidate package', () => {
  const env = childEnvironment({
    PATH: '/usr/bin', FACTORY_HEAD: sha, COPILOT_GITHUB_TOKEN: 'never-forward',
    FACTORY_READ_TOKEN: 'never-forward', FACTORY_GITHUB_TOKEN: 'never-forward',
    ACTIONS_RUNTIME_TOKEN: 'never-forward', NODE_OPTIONS: '--require=untrusted.js',
    APP_ROOT: 'untrusted-path'
  }, '/project');
  assert.equal(env.APP_ROOT, 'dist/app');
  assert.equal(env.BUILD_ID, sha);
  assert.equal(env.TMPDIR, '/project/.factory-runtime/scratch');
  for (const key of ['COPILOT_GITHUB_TOKEN', 'FACTORY_READ_TOKEN', 'FACTORY_GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NODE_OPTIONS']) {
    assert.equal(env[key], undefined);
  }
});

test('worker audit retains the CLI requested model and effort without claiming backend observation', () => {
  const result = {
    requested: { modelId: 'fixture-model', effort: 'high' },
    requestedModel: 'obsolete-field-must-not-be-used',
    auditPath: '/project/.factory/runs/fixture/calls/one.json',
    output: 'private model output',
    telemetry: 'private telemetry'
  };
  assert.deepEqual(inferenceAudit('review', result, '/project'), {
    role: 'review', requested: { modelId: 'fixture-model', effort: 'high' },
    auditPath: '.factory/runs/fixture/calls/one.json'
  });
  assert.throws(() => inferenceAudit('review', { ...result, requested: undefined }, '/project'));
});

const workflowSource = name => readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
const jobSource = (source, name) => source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][\\w-]*:\\n|$(?![\\s\\S]))`, 'm'))?.[0];

test('worker and device workflow files implement the exact dispatch and single-result ZIP contracts', async () => {
  for (const name of ['factory-worker', 'factory-device']) {
    const source = await workflowSource(name);
    assert.match(source, /^run-name: factory:\$\{\{ inputs.task \}\}:\$\{\{ inputs.stage \}\}:\$\{\{ inputs.key \}\}$/m);
    const inputs = source.slice(source.indexOf('    inputs:\n'), source.indexOf('\npermissions:'));
    assert.deepEqual([...inputs.matchAll(/^      ([a-z]+):$/gm)].map(match => match[1]).sort(),
      ['base', 'harness', 'head', 'key', 'stage', 'task']);
    assert.match(source, /name: factory-result-\$\{\{ inputs.key \}\}/);
    assert.match(source, /path: \.factory-output\/final\/result\.json/);
    assert.match(source, /FACTORY_READ_TOKEN: \$\{\{ github.token \}\}/);
    assert.match(jobSource(source, 'authorize'), /run: node factory\/worker\.mjs gate/);
    const uploads = source.split(/^\s+- (?:name: .+\n\s+)?uses: actions\/upload-artifact@/m).slice(1);
    assert.ok(uploads.length > 0);
    for (const upload of uploads) {
      const step = upload.split(/^\s+- (?:name|uses|run):/m)[0];
      assert.match(step, /archive: true/);
      assert.match(step, /include-hidden-files: true/);
      assert.match(step, /if-no-files-found: error/);
      assert.match(step, /retention-days: 1/);
      assert.match(step, /path: \.factory-output\/(?:final|tests|review)\/result\.json/);
    }
  }
});

test('workflow credential boundaries keep controller, browser, inference and LAN separate', async () => {
  const worker = await workflowSource('factory-worker');
  const controller = await workflowSource('factory-controller');
  const device = await workflowSource('factory-device');
  const tests = jobSource(worker, 'tests');
  assert.ok(tests);
  assert.match(tests, /playwright install --with-deps chromium/);
  assert.match(tests, /run: node factory\/worker\.mjs validate/);
  assert.doesNotMatch(tests, /secrets\.|copilot|environment:/);
  for (const role of ['infer', 'review']) {
    const job = jobSource(worker, role);
    assert.match(job, /needs: authorize/);
    assert.match(job, /environment: factory-inference/);
    assert.match(job, /@github\/copilot@1\.0\.83/);
    assert.match(job, /COPILOT_GITHUB_TOKEN: \$\{\{ secrets.COPILOT_GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(job, /playwright|FACTORY_APP_PRIVATE_KEY|FACTORY_GITHUB_TOKEN/);
  }
  assert.match(jobSource(worker, 'combine'), /needs: \[authorize, tests, review\]/);
  assert.match(controller, /authorizeController/);
  assert.match(controller, /await runProduction\(\)/);
  assert.match(controller, /FACTORY_SCHEDULE_ENABLED == 'true'/);
  assert.match(controller, /environment: factory-control/);
  assert.match(controller, /repositories: TzOneDrive/);
  assert.doesNotMatch(controller, /^\s+run:.*(?:npm|playwright|worker\.mjs|app\/)/m);
  assert.doesNotMatch(controller, /COPILOT_GITHUB_TOKEN|permission-workflows:/);
  assert.doesNotMatch(worker + device, /FACTORY_APP_PRIVATE_KEY|FACTORY_GITHUB_TOKEN|permission-[\w-]+: write/);
  assert.match(device, /node factory\/worker\.mjs device-blocked/);
  assert.doesNotMatch(device, /secrets\.|self-hosted|run:.*(?:device\.mjs|playwright|copilot)/);
  for (const source of [worker, controller, device, await workflowSource('ci'), await workflowSource('factory-mock')]) {
    assert.doesNotMatch(source, /pull_request_target|workflow_run:|continue-on-error:|\|\| true/);
    assert.equal((source.match(/uses: actions\/checkout@/g) || []).length,
      (source.match(/persist-credentials: false/g) || []).length);
    for (const run of source.matchAll(/^\s+run: (.+(?:\n(?: {10,}.*|$))*)/gm)) {
      assert.doesNotMatch(run[1], /\$\{\{/);
    }
    for (const runner of source.matchAll(/^\s+runs-on: (.*)$/gm)) assert.equal(runner[1], 'ubuntu-24.04');
  }
});

test('secretless CI requires Chromium and bounded mocks, never optional browser success', async () => {
  const ci = await workflowSource('ci');
  assert.match(ci, /^  pull_request:\n  push:\n    branches-ignore: \[factory-ledger\]$/m);
  assert.doesNotMatch(ci, /^\s+branches:/m);
  for (const command of [
    'npm ci --ignore-scripts', 'npm test', 'npm run check', 'npm run build',
    'npx --no-install playwright install --with-deps chromium', 'npm run test:browser',
    'npm run factory:mock -- --max-actions 50 --experiment-ms 60000'
  ]) assert.ok(ci.includes(`run: ${command}`), command);
  assert.match(ci, /APP_ROOT: dist\/app/);
  assert.doesNotMatch(ci, /secrets\.|: write|continue-on-error/);
  const mock = await workflowSource('factory-mock');
  assert.match(mock, /MOCK_SCENARIO: \$\{\{ inputs.scenario \}\}/);
  assert.match(mock, /--scenario "\$MOCK_SCENARIO" --max-actions 50 --experiment-ms 60000/);
  assert.doesNotMatch(mock, /secrets\.|: write/);
});
