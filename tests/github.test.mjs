import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { GitHubAPI, GitHubContentsLedger, GitHubError, extractResult } from '../factory/github-api.mjs';
import {
  GitHubAdapter, validateEdits, correlation, defaultHead, marker,
  authorizeController, authorizeDispatch, createAdapter, isEnabled, runProduction, wireKey
} from '../factory/github-adapter.mjs';
import { advance, createState } from '../factory/controller.mjs';
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

test('existing merges must have the exact tested tree before returning a success receipt', async () => {
  const head = 'b'.repeat(40);
  const mergedSha = 'c'.repeat(40);
  const testedTree = 'd'.repeat(40);
  for (const matches of [true, false]) {
    const reads = [];
    const api = { request: async (method, pathname) => {
      assert.equal(method, 'GET', 'An existing merge is only inspected, never rewritten');
      reads.push(pathname);
      if (pathname === '') return { full_name: config.repository, default_branch: 'master' };
      if (pathname === '/commits/master') return { sha: mergedSha };
      if (pathname === `/contents/factory/trusted-config.json?ref=${mergedSha}`) return jsonFile(config);
      if (pathname === '/pulls/42') return {
        number: 42, user: { login: config.appBotLogin }, body: marker('one', 'publish-key'),
        head: { sha: head, repo: { full_name: config.repository } }, base: { ref: 'master', sha },
        merged: true, merge_commit_sha: mergedSha
      };
      if (pathname === `/git/commits/${head}`) return { tree: { sha: testedTree } };
      if (pathname === `/git/commits/${mergedSha}`) return { tree: { sha: matches ? testedTree : 'e'.repeat(40) } };
      throw new Error(`Unexpected merge read: ${pathname}`);
    } };
    const adapter = new GitHubAdapter({ api });
    const request = { taskId: 'one', key: 'publish-key', number: 42, head, base: sha };
    if (matches) assert.deepEqual(await adapter.mergePR(request), { merged: true, sha: mergedSha });
    else await assert.rejects(adapter.mergePR(request), /Merged tree differs from the tested tree; deployment forbidden/);
    assert.ok(reads.includes(`/git/commits/${head}`));
    assert.ok(reads.includes(`/git/commits/${mergedSha}`));
  }
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
  task.evidence.pr = { prNumber: 42, headSha: candidate, publishKey: 'publish-key' };
  const files = [{ path: 'app/build.json', size: 1, sha256: 'd'.repeat(64) }];
  const treeHash = createHash('sha256').update(files.map(file => `${file.path}\0${file.sha256}\n`).join('')).digest('hex');
  const manifest = { schemaVersion: 1, version: '1.0.0', commit: candidate, buildId: candidate,
    mode: 'production', appId: 'TzOneDrive.PhotoViewer', packageId: 'TzOneDrive', treeHash, files };
  task.evidence.validate = { verdict: 'PASS', headSha: candidate, testedSha: candidate, ciPassed: true,
    independentReview: { verdict: 'PASS', independent: true, reviewer: 'synthetic-review-fixture' },
    package: { headSha: candidate, buildId: candidate, sha256: treeHash, manifest } };
  task.evidence.merge = { merged: true, headSha: candidate, mergeSha: sha };
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
  const pr = { number: 42, merged: true, merge_commit_sha: sha, body: marker(task.id, 'publish-key'),
    head: { sha: candidate, repo: { full_name: config.repository } },
    base: { ref: 'master' }, user: { login: config.appBotLogin } };
  const sourceTrees = { tested: 'e'.repeat(40), merged: 'e'.repeat(40) };
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
    if (path === `/git/commits/${candidate}`) return { tree: { sha: sourceTrees.tested } };
    if (path === `/git/commits/${sha}`) return { tree: { sha: sourceTrees.merged } };
    if (path === `/contents/factory/model-policy.json?ref=${sha}`) {
      return jsonFile(JSON.parse(await readFile(new URL('../factory/model-policy.json', import.meta.url))));
    }
    if (path === `/contents/factory/model-catalog.json?ref=${sha}`) throw new GitHubError(404, 'Missing catalog');
    throw new Error(`Unexpected test API read: ${path}`);
  } };
  return { api, inputs, env, configured, state, task, pr, writes, workflow, sourceTrees };
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
    const checkpoints = [];
    const checkpoint = async ticket => { checkpoints.push(structuredClone(ticket)); };
    const remote = {
      list: async () => [],
      request: async (method, path, body) => {
        if (method === 'POST') {
          assert.equal(checkpoints.at(-1)?.key, inputs.key, 'Ticket must be checkpointed before POST');
          calls.push({ path, body });
          return null;
        }
        return api.request(method, path, body);
      }
    };
    const adapter = new GitHubAdapter({ api: remote });
    await assert.rejects(adapter.dispatchRun({ ...inputs, taskId: inputs.task }), /durable pending checkpoint/);
    const ticket = await adapter.dispatchRun({ ...inputs, taskId: inputs.task }, checkpoint);
    assert.equal(ticket.workflow, workflow);
    assert.deepEqual(calls, [{
      path: `/actions/workflows/${workflow}/dispatches`, body: { ref: 'master', inputs }
    }]);
    remote.list = async () => [{
      id: 123, head_sha: sha, event: 'workflow_dispatch',
      display_title: correlation(inputs.task, stage, inputs.key), actor: { login: config.appBotLogin }
    }];
    assert.equal((await adapter.dispatchRun({ ...inputs, taskId: inputs.task }, checkpoint)).runId, 123);
    assert.equal(calls.length, 1, 'A persisted intent must not dispatch a duplicate run');
    assert.equal(checkpoints.at(-1).runId, 123);
  }
});

function restartableDispatch(failure) {
  const fixture = dispatchFixture();
  let durable = createState([{ id: 'one', goal: 'Trusted synthetic goal' }], {
    mode: 'real', now: 1000000, limits: { maxPolls: 2 }
  });
  let failed = false;
  let visible = false;
  let posts = 0;
  const ticket = () => durable.tasks[0].intent.pending.ticket;
  const api = {
    request: async (method, pathname, body) => {
      if (method === 'POST') {
        assert.equal(pathname, '/actions/workflows/factory-worker.yml/dispatches');
        assert.equal(ticket().key, body.inputs.key, 'Durable ticket must exist when POST is attempted');
        posts++;
        if (failure === 'ambiguous-transport' && !failed) {
          failed = true;
          throw new Error('dispatch accepted, response lost');
        }
        return null;
      }
      return fixture.api.request(method, pathname, body);
    },
    list: async pathname => {
      if (posts && failure === 'after-post' && !failed) {
        failed = true;
        throw new Error('crash after successful POST');
      }
      if (!visible || !posts) return [];
      if (pathname.endsWith('/artifacts')) return [{
        id: 77, name: `factory-result-${ticket().key}`, expired: false, workflow_run: { id: 123 }
      }];
      return [{
        id: 123, display_title: correlation(ticket().taskId, ticket().stage, ticket().key),
        head_sha: sha, event: 'workflow_dispatch', actor: { login: config.appBotLogin },
        path: '.github/workflows/factory-worker.yml', status: 'completed', conclusion: 'success'
      }];
    },
    downloadResult: async () => ({ ...ticket(), plan: 'Recovered trusted plan' })
  };
  const persist = next => {
    const hasTicket = Boolean(next.tasks[0].intent?.pending?.ticket);
    if (hasTicket && failure === 'checkpoint-storage' && !failed) {
      failed = true;
      throw new Error('checkpoint storage failed');
    }
    durable = structuredClone(next);
    if (hasTicket && failure === 'before-post' && !failed) {
      failed = true;
      throw new Error('crash after durable checkpoint, before POST');
    }
  };
  return {
    state: () => durable,
    posts: () => posts,
    showRun: () => { visible = true; },
    step: async () => advance(durable, await createAdapter({ api, env: fixture.env }), {
      now: durable.tasks[0].nextActionAt ?? durable.updatedAt, persist
    })
  };
}

test('workflow ticket persistence failure prevents dispatch POST', async () => {
  const run = restartableDispatch('checkpoint-storage');
  await assert.rejects(run.step(), /checkpoint storage failed/);
  assert.equal(run.posts(), 0);
  assert.equal(run.state().tasks[0].intent.pending, null);
});

test('crash after checkpoint but before POST only polls on restart and blocks within limits', async () => {
  const run = restartableDispatch('before-post');
  await assert.rejects(run.step(), /before POST/);
  const key = run.state().tasks[0].intent.key;
  assert.equal(run.state().status, 'waiting');
  for (let index = 0; index < 3; index++) await run.step();
  assert.equal(run.posts(), 0);
  assert.equal(run.state().status, 'blocked');
  assert.equal(run.state().tasks[0].blockedReason, 'poll-limit');
  assert.equal(run.state().tasks[0].intent.key, key);
  assert.equal(run.state().tasks[0].attempts.plan, 1);
});

test('successful or ambiguous dispatch followed by listing lag never POSTs twice after restart', async () => {
  for (const failure of ['after-post', 'ambiguous-transport']) {
    const run = restartableDispatch(failure);
    await assert.rejects(run.step(), /successful POST|response lost/);
    const savedTicket = structuredClone(run.state().tasks[0].intent.pending.ticket);
    assert.equal(run.posts(), 1);
    await run.step();
    assert.equal(run.posts(), 1);
    assert.equal(run.state().status, 'waiting');
    assert.deepEqual(run.state().tasks[0].intent.pending.ticket, savedTicket);
    run.showRun();
    await run.step();
    assert.equal(run.posts(), 1);
    assert.equal(run.state().tasks[0].stage, 'implement');
    assert.equal(run.state().tasks[0].evidence.plan.verdict, 'PASS');
    assert.equal(run.state().tasks[0].attempts.plan, 1);
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
    ({ task }) => { task.evidence.validate.ciPassed = false; },
    ({ task }) => { task.evidence.validate.independentReview.independent = false; },
    ({ task }) => { task.evidence.validate.package.manifest.commit = 'c'.repeat(40); },
    ({ task }) => { task.evidence.merge.headSha = 'c'.repeat(40); },
    ({ sourceTrees }) => { sourceTrees.merged = 'f'.repeat(40); },
    ({ pr }) => { pr.merged = false; },
    ({ pr }) => { pr.number = 1; },
    ({ pr }) => { pr.merge_commit_sha = 'c'.repeat(40); },
    ({ pr }) => { pr.head.sha = 'c'.repeat(40); },
    ({ pr }) => { pr.user.login = 'other'; },
    ({ pr }) => { pr.body = 'No factory marker'; },
    ({ pr }) => { pr.head.repo.full_name = 'other/repo'; },
    ({ inputs }) => { inputs.base = 'c'.repeat(40); }
  ]) {
    const fixture = dispatchFixture('deploy');
    mutate(fixture);
    await assert.rejects(authorizeDispatch(fixture.api, fixture.inputs, fixture.env));
  }
});

test('public deployment artifacts and embedded acceptance cannot supply private transport authentication', async () => {
  const { api, env, task } = dispatchFixture('deploy');
  const adapter = await createAdapter({ api, env });
  adapter.pollRun = async () => ({ status: 'completed', result: {
    receipt: { verdict: 'PASS', simulated: false, gateEligible: true, rawCamera: '/private/frame.png' },
  } });
  const context = { idempotencyKey: 'synthetic-key', now: Date.now(), evidence: task.evidence,
    previousReceipt: { ticket: { head: sha } } };
  for (const action of ['deploy', 'accept']) {
    const result = await adapter.execute(action, task, context);
    assert.deepEqual(result, { verdict: 'INCONCLUSIVE', simulated: false, reasonCode: 'PRIVATE_DEVICE_TRANSPORT_REQUIRED' });
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
  for (const source of [worker, controller, device, await workflowSource('ci'), await workflowSource('factory-mock'), await workflowSource('web-preview')]) {
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

test('Pages preview publishes only master assets after secretless browser and mock checks', async () => {
  const source = await workflowSource('web-preview');
  assert.match(source, /^on:\n  push:\n    branches: \[master\]\n  workflow_dispatch:/m);
  assert.doesNotMatch(source, /pull_request|workflow_run|secrets\.|self-hosted/);
  assert.match(source, /^permissions:\n  contents: read\n/m);
  assert.match(source, /group: github-pages\n  cancel-in-progress: false/);
  const build = jobSource(source, 'build');
  const deploy = jobSource(source, 'deploy');
  for (const job of [build, deploy]) {
    assert.match(job, /github\.repository == 'VasiliyNovikov\/TzOneDrive'/);
    assert.match(job, /github\.ref == 'refs\/heads\/master'/);
  }
  assert.doesNotMatch(build, /: write|environment:|FACTORY_ENABLED|factory\/(?:worker|device|github-adapter)/);
  assert.match(build, /BUILD_ID: \$\{\{ github.sha \}\}/);
  assert.match(build, /ref: \$\{\{ github.sha \}\}/);
  assert.match(build, /APP_ROOT: dist\/app\n      APP_BASE_PATH: \/TzOneDrive\//);
  let previous = -1;
  for (const step of [
    'run: npm ci --ignore-scripts', 'run: npm test', 'run: npm run check', 'run: npm run build',
    'run: npx --no-install playwright install --with-deps chromium', 'run: npm run test:browser',
    'run: npm run factory:mock -- --max-actions 50 --experiment-ms 60000',
    'uses: actions/upload-pages-artifact@',
  ]) {
    const position = build.indexOf(step);
    assert.ok(position > previous, step);
    previous = position;
  }
  assert.match(build, /path: dist\/app\n          retention-days: 1/);
  assert.match(deploy, /needs: build/);
  assert.match(deploy, /permissions:\n      pages: write\n      id-token: write/);
  assert.match(deploy, /environment:\n      name: github-pages\n      url: \$\{\{ steps.deployment.outputs.page_url \}\}/);
  assert.match(deploy, /uses: actions\/deploy-pages@[a-f0-9]{40}/);
  assert.doesNotMatch(deploy, /run:|checkout@|contents: write|FACTORY_|COPILOT_/);
});
