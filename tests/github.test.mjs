import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAPI, GitHubContentsLedger, GitHubError, extractResult } from '../factory/github-api.mjs';
import { GitHubAdapter, validateEdits, correlation, defaultHead, marker } from '../factory/github-adapter.mjs';

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

function artifactJSON(value) {
  const data = Buffer.from(JSON.stringify(value));
  const name = Buffer.from('result.json');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

test('artifact parser accepts only a single bounded result.json without extraction', () => {
  assert.deepEqual(JSON.parse(extractResult(artifactJSON({ ok: true }))), { ok: true });
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
