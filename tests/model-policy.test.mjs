import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertPinnedResolution, digest, resolvePolicy } from '../factory/model-policy.mjs';
import {
  SAFE_CONFIG, SAFETY_FLAGS, buildControlledEnvironment, buildInvocationArgs, invokeRole, preflight,
  verifyTelemetry
} from '../factory/cli.mjs';

const shipped = JSON.parse(await readFile(new URL('../factory/model-policy.json', import.meta.url), 'utf8'));
const NOW = '2026-09-14T10:00:00.000Z';
const fixtureToken = 'github_pat_fixture_not_a_credential';

function fixtures() {
  const policy = structuredClone(shipped);
  const evidence = ['picker', 'efforts', 'modalities', 'responses', 'auth', 'owner'].map(id => ({
    id, path: `${id}.txt`, source: `Synthetic test evidence: ${id}`, sha256: digest(id)
  }));
  const model = (displayName, id, supportedEfforts) => ({
    displayName, id, available: true, flagship: true, supportedEfforts, effortsComplete: true,
    inputModalities: ['text'], responseModelIds: [id],
    availabilityEvidence: ['picker'], effortEvidence: ['efforts'],
    modalityEvidence: ['modalities'], responseModelEvidence: ['responses']
  });
  const catalog = {
    schemaVersion: 1,
    cli: { package: '@github/copilot', version: '1.0.83' },
    capturedAt: '2026-09-14T09:00:00.000Z',
    expiresAt: '2026-09-14T12:00:00.000Z',
    review: {
      approved: true, reviewer: 'test-owner', reviewedAt: '2026-09-14T09:30:00.000Z',
      method: 'manual-authenticated-cli', notes: 'Synthetic unit-test evidence, not real model availability.', evidence
    },
    authentication: {
      type: 'fine-grained-pat', account: 'test-owner', repositoryAccess: 'none',
      tokenSha256: digest(fixtureToken), permissions: { copilot_requests: 'write' },
      expiresAt: '2026-09-15T09:00:00.000Z', evidence: ['auth']
    },
    models: [
      model('GPT-6 Astra', 'fixture-astra', ['high', 'xhigh']),
      model('Claude Opus 5', 'claude-opus-5', ['medium', 'high', 'max']),
      { ...model('Owner-selected test flagship', 'fixture-visual', ['high']), inputModalities: ['text', 'image'] }
    ]
  };
  return { policy, catalog };
}

function resolve(policy, catalog, extra = {}) {
  return resolvePolicy(policy, catalog, {
    now: NOW, runId: 'policy-unit-test', roles: ['planning', 'implementation', 'repair', 'review'], ...extra
  });
}

function approveVisual(policy) {
  policy.roles.visual = {
    desiredDisplayName: 'Owner-selected test flagship', modelId: 'fixture-visual',
    flagship: true, effort: 'highest-supported',
    ownerApproval: {
      approved: true, owner: 'test-owner', approvedAt: NOW, modelId: 'fixture-visual', evidence: ['owner']
    }
  };
}

function code(expected) {
  return error => error.code === expected;
}

test('shipped desired policy is explicitly unvalidated, has no guessed Astra ID or visual approval', () => {
  assert.equal(shipped.validationStatus, 'unvalidated');
  for (const role of ['planning', 'implementation', 'repair']) assert.equal(shipped.roles[role].modelId, null);
  assert.equal(shipped.roles.review.modelId, 'claude-opus-5');
  assert.equal(shipped.roles.visual, null);
  assert.throws(() => resolve(shipped, null), code('CATALOG_REQUIRED'));
});

test('policy selects each model highest supported effort, not the CLI-wide maximum', () => {
  const { policy, catalog } = fixtures();
  const result = resolve(policy, catalog);
  assert.equal(result.roles.planning.modelId, 'fixture-astra');
  assert.equal(result.roles.planning.effort, 'xhigh');
  assert.equal(result.roles.review.effort, 'max');
  assert.equal(result.roles.implementation.modelId, result.roles.repair.modelId);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.roles.planning.responseModelIds));
  assert.throws(() => { result.roles.planning.modelId = 'other'; }, TypeError);
});

test('unavailable, ambiguous, unreviewed and unverified models fail closed', () => {
  for (const change of [
    catalog => { catalog.models[0].available = false; },
    catalog => { catalog.models[0].flagship = false; },
    catalog => { catalog.models[0].displayName = 'A smaller alternative'; },
    catalog => { catalog.models.push({ ...catalog.models[0], id: 'ambiguous-id' }); }
  ]) {
    const { policy, catalog } = fixtures();
    change(catalog);
    assert.throws(() => resolve(policy, catalog), code('MODEL_UNAVAILABLE'));
  }
  const { policy, catalog } = fixtures();
  catalog.review.approved = false;
  assert.throws(() => resolve(policy, catalog), code('CATALOG_NOT_REVIEWED'));
  catalog.review.approved = true;
  catalog.models[0].availabilityEvidence = [];
  assert.throws(() => resolve(policy, catalog), code('MISSING_EVIDENCE'));
});

test('unknown, incomplete or duplicate effort capabilities cannot be guessed', () => {
  for (const efforts of [[], ['extreme'], ['high', 'high']]) {
    const { policy, catalog } = fixtures();
    catalog.models[0].supportedEfforts = efforts;
    assert.throws(() => resolve(policy, catalog), code('UNKNOWN_EFFORT'));
  }
  const { policy, catalog } = fixtures();
  catalog.models[0].effortsComplete = false;
  assert.throws(() => resolve(policy, catalog), code('UNKNOWN_EFFORT'));
});

test('model auto/latest, lower-tier substitutions and policy effort overrides are rejected', () => {
  for (const modelId of ['auto', 'latest', 'gpt-latest', 'auto/fixture']) {
    const { policy, catalog } = fixtures();
    policy.roles.planning.modelId = modelId;
    assert.throws(() => resolve(policy, catalog), code('INVALID_MODEL_ID'));
  }
  const { policy, catalog } = fixtures();
  policy.roles.planning.desiredDisplayName = 'Small cheap model';
  assert.throws(() => resolve(policy, catalog), code('MODEL_DOWNGRADE'));
  policy.roles.planning.desiredDisplayName = 'GPT-6 Astra';
  policy.roles.planning.effort = 'high';
  assert.throws(() => resolve(policy, catalog), code('MODEL_DOWNGRADE'));
});

test('visual requires owner-approved exact flagship and verified native image modality', () => {
  const { policy, catalog } = fixtures();
  assert.throws(() => resolve(policy, catalog, { roles: ['visual'] }), code('VISUAL_APPROVAL_REQUIRED'));
  approveVisual(policy);
  const pinned = resolve(policy, catalog, { roles: ['visual'] });
  assert.equal(pinned.roles.visual.modelId, 'fixture-visual');
  policy.roles.visual.ownerApproval.approved = false;
  assert.throws(() => resolve(policy, catalog, { roles: ['visual'] }), code('VISUAL_APPROVAL_REQUIRED'));
  policy.roles.visual.ownerApproval.approved = true;
  catalog.models[2].inputModalities = ['text'];
  assert.throws(() => resolve(policy, catalog, { roles: ['visual'] }), code('UNKNOWN_MODALITY'));
});

test('fine-grained inference credentials must have no repository or App-token permission', () => {
  const { policy, catalog } = fixtures();
  catalog.authentication.type = 'github-app';
  assert.throws(() => resolve(policy, catalog), code('AUTH_SCOPE'));
  catalog.authentication.type = 'fine-grained-pat';
  catalog.authentication.permissions.contents = 'read';
  assert.throws(() => resolve(policy, catalog), code('AUTH_SCOPE'));
  delete catalog.authentication.permissions.contents;
  catalog.authentication.repositoryAccess = 'selected';
  assert.throws(() => resolve(policy, catalog), code('AUTH_SCOPE'));
});

test('catalog and run snapshots expire and reject CLI version drift', () => {
  const { policy, catalog } = fixtures();
  const pin = resolve(policy, catalog);
  assert.equal(pin.expiresAt, '2026-09-14T11:00:00.000Z');
  assertPinnedResolution(pin, policy, catalog, { now: '2026-09-14T10:59:59.000Z' });
  assert.throws(() => assertPinnedResolution(pin, policy, catalog, { now: pin.expiresAt }), code('PIN_EXPIRED'));
  assert.throws(() => resolve(policy, catalog, { now: catalog.expiresAt }), code('CATALOG_EXPIRED'));
  catalog.cli.version = '1.0.84';
  assert.throws(() => resolve(policy, catalog), code('CLI_PIN_MISMATCH'));
});

test('snapshot cannot mutate model, catalog evidence, policy, run ID or issuance time', () => {
  const { policy, catalog } = fixtures();
  const pin = resolve(policy, catalog);
  const modified = structuredClone(pin);
  modified.roles.planning.effort = 'high';
  assert.throws(() => assertPinnedResolution(modified, policy, catalog, { now: NOW }), code('PIN_CHANGED'));
  const renamed = { ...pin, runId: 'another-run' };
  assert.throws(() => assertPinnedResolution(renamed, policy, catalog, { now: NOW }), code('PIN_CHANGED'));
  catalog.review.notes += ' changed';
  assert.throws(() => assertPinnedResolution(pin, policy, catalog, { now: NOW }), code('PIN_CHANGED'));
});

test('inference environment is an allowlist, not an ambient credential/config merge', () => {
  const paths = { home: '/project/isolated/home', copilotHome: '/project/isolated/home/.copilot', workdir: '/project/isolated/context', telemetryPath: '/project/isolated/otel.jsonl' };
  const hostile = {
    COPILOT_GITHUB_TOKEN: fixtureToken, GH_TOKEN: 'publishing-token', GITHUB_TOKEN: 'app-token',
    COPILOT_MODEL: 'auto', COPILOT_PROVIDER_BASE_URL: 'https://untrusted.invalid',
    COPILOT_PROVIDER_API_KEY: 'byok', COPILOT_ALLOW_ALL: 'true', COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/repo',
    COPILOT_HOME: '/unsafe', HOME: '/unsafe', XDG_CONFIG_HOME: '/unsafe', NODE_OPTIONS: '--import bad.mjs',
    BASH_ENV: '/unsafe.sh', PATH: '/malicious', HTTPS_PROXY: 'https://untrusted.invalid',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://untrusted.invalid', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true'
  };
  const env = buildControlledEnvironment(hostile, { ...paths, authenticate: true });
  for (const key of Object.keys(hostile).filter(key => ![
    'COPILOT_GITHUB_TOKEN', 'HOME', 'COPILOT_HOME', 'XDG_CONFIG_HOME', 'PATH',
    'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'
  ].includes(key))) assert.equal(env[key], undefined, key);
  assert.equal(env.COPILOT_GITHUB_TOKEN, fixtureToken);
  assert.equal(env.HOME, paths.home);
  assert.equal(env.COPILOT_OTEL_EXPORTER_TYPE, 'file');
  assert.equal(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT, 'false');
  assert.ok(!env.PATH.includes('malicious'));
  assert.equal(buildControlledEnvironment(hostile, paths).COPILOT_GITHUB_TOKEN, undefined);
  assert.throws(() => buildControlledEnvironment({ GH_TOKEN: fixtureToken }, { ...paths, authenticate: true }), code('AUTH_REQUIRED'));
});

test('tool-less invocation pins model/effort and does not grant shell, write, subagent or broad permissions', () => {
  const { policy, catalog } = fixtures();
  const resolved = resolve(policy, catalog).roles.implementation;
  const args = buildInvocationArgs({
    role: 'implementation', prompt: 'Untrusted text --model auto; $(touch forbidden)', resolved, logDir: '/project/logs'
  });
  assert.deepEqual(args.slice(0, SAFETY_FLAGS.length), SAFETY_FLAGS);
  assert.equal(args[args.indexOf('--model') + 1], 'fixture-astra');
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
  assert.ok(args.includes('--available-tools='));
  assert.ok(args.some(arg => arg.startsWith('--excluded-tools=task,')));
  assert.ok(args.includes('--deny-tool=shell'));
  assert.ok(args.includes('--deny-tool=write'));
  for (const forbidden of ['--allow-all', '--allow-all-tools', '--allow-all-paths', '--autopilot', '--agent', '--plugin-dir', '--resume', '--continue']) {
    assert.ok(!args.includes(forbidden));
  }
  assert.equal(SAFE_CONFIG.continueOnAutoMode, false);
  assert.equal(SAFE_CONFIG.disableAllHooks, true);
  assert.equal(SAFE_CONFIG.ide.autoConnect, false);
  assert.ok(args.at(-1).includes('app/**'));
});

test('native image attachment is explicit; text-only roles never receive files', () => {
  const resolved = { modelId: 'fixture-visual', effort: 'high' };
  const args = buildInvocationArgs({
    role: 'visual', prompt: 'Review the image', resolved, attachments: ['/project/evidence.png'], logDir: '/project/logs'
  });
  assert.equal(args[args.indexOf('--attachment') + 1], '/project/evidence.png');
  assert.throws(() => buildInvocationArgs({ role: 'visual', prompt: 'x', resolved }), code('ATTACHMENT_POLICY'));
  assert.throws(() => buildInvocationArgs({ role: 'review', prompt: 'x', resolved, attachments: ['image.png'] }), code('ATTACHMENT_POLICY'));
});

test('public production entry points reject config, model, arguments, environment and execution overrides', async () => {
  for (const field of ['model', 'effort', 'env', 'config', 'extraArgs', 'exec', 'runner', 'availableTools']) {
    await assert.rejects(preflight({ cwd: process.cwd(), [field]: 'unsafe' }), code('CONFIG_OVERRIDE'));
    await assert.rejects(invokeRole({ cwd: process.cwd(), [field]: 'unsafe' }), code('CONFIG_OVERRIDE'));
  }
});

test('no successful inference result can be fabricated without supported telemetry', () => {
  assert.throws(() => verifyTelemetry(''), error => ['MISSING_TELEMETRY', 'TELEMETRY_SCHEMA_UNVERIFIED'].includes(error.code));
});

test('documented model attribute names alone cannot attest a backend response', () => {
  const attributes = {
    'gen_ai.request.model': 'fixture-astra',
    'gen_ai.response.model': 'fixture-astra',
    'gen_ai.response.finish_reasons': ['stop']
  };
  const resolved = { modelId: 'fixture-astra', effort: 'xhigh', responseModelIds: ['fixture-astra'] };
  for (const record of [attributes, { attributes }, { resourceSpans: [{ attributes }] }]) {
    assert.throws(() => verifyTelemetry(`${JSON.stringify(record)}\n`, resolved));
  }
});

async function mockProject({ telemetry = null, telemetryKind = 'file' } = {}) {
  const root = path.join(process.cwd(), '.factory', `policy-test-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const { policy, catalog } = fixtures();
  const now = Date.now();
  catalog.capturedAt = new Date(now - 300000).toISOString();
  catalog.review.reviewedAt = new Date(now - 100000).toISOString();
  catalog.expiresAt = new Date(now + 3600000).toISOString();
  catalog.authentication.expiresAt = new Date(now + 86400000).toISOString();
  for (const evidence of catalog.review.evidence) {
    await writeFile(path.join(root, evidence.path), evidence.id, { mode: 0o600 });
  }
  const cliPath = path.join(root, 'fake-copilot.mjs');
  const help = [
    '--model', '--effort', '--attachment', '--available-tools', '--excluded-tools', '--deny-tool',
    '--disable-builtin-mcps', '--no-custom-instructions', '--no-experimental', '--no-auto-update',
    '--no-remote', '--no-remote-export', '--no-bash-env', '--disallow-temp-dir', '--no-ask-user',
    '--silent', '--stream', '--prompt', '--log-dir'
  ].join('\n');
  const config = ['continueOnAutoMode', 'disableAllHooks', 'ide.autoConnect', 'stayInAutopilot']
    .map(key => `\`${key}\``).join('\n');
  await writeFile(cliPath, `#!${process.execPath}
import {writeFileSync,readFileSync,existsSync,readdirSync,symlinkSync,linkSync,truncateSync} from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const topic = args[0] === 'help' ? args[1] : args[0];
const help = ${JSON.stringify({
    '--version': 'GitHub Copilot CLI 1.0.83.',
    '--help': help,
    config,
    environment: 'COPILOT_HOME COPILOT_GITHUB_TOKEN COPILOT_OTEL_FILE_EXPORTER_PATH COPILOT_OTEL_EXPORTER_TYPE',
    monitoring: 'gen_ai.invoke_agent.inference_calls JSON-lines',
    permissions: '--available-tools disables all other tools',
    commands: '/model'
  })};
if (help[topic]) { console.log(help[topic]); }
else {
  const telemetry = ${JSON.stringify(telemetry)};
  const telemetryKind = ${JSON.stringify(telemetryKind)};
  const telemetryPath = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  if (telemetryKind === 'symlink') symlinkSync(process.argv[1], telemetryPath);
  else if (telemetryKind === 'hardlink') linkSync(process.argv[1], telemetryPath);
  else if (telemetryKind === 'oversized') {
    writeFileSync(telemetryPath, '');
    truncateSync(telemetryPath, 16 * 1024 * 1024 + 1);
  } else if (telemetry !== null) writeFileSync(telemetryPath, Buffer.from(telemetry));
  writeFileSync(${JSON.stringify(path.join(root, 'invocation.json'))}, JSON.stringify({
    args, cwd:process.cwd(), environmentKeys:Object.keys(process.env),
    home:process.env.HOME, config:JSON.parse(readFileSync(path.join(process.env.COPILOT_HOME,'config.json'))),
    contextFiles:readdirSync(process.cwd()), sourceRepositoryVisible:existsSync(path.join(process.cwd(),'app')),
    gitHead:readFileSync(path.join(process.cwd(),'.git','HEAD'),'utf8')
  }));
  console.log(JSON.stringify({edits:[],fixture:true}));
}
`, { mode: 0o700 });
  return { root, policy, catalog, cliPath };
}

test('mocked subprocess demonstrates permission isolation and rejects output without backend telemetry', async () => {
  const fixture = await mockProject();
  const previous = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = fixtureToken;
  try {
    const options = {
      cwd: fixture.root, policy: fixture.policy, catalog: fixture.catalog,
      cliPath: fixture.cliPath, runId: 'isolated-invocation', roles: ['implementation']
    };
    const result = await preflight(options);
    const persisted = JSON.parse(await readFile(result.snapshotPath, 'utf8'));
    assert.equal(persisted.inference, 'not-run');
    assert.equal(persisted.resolution.snapshotHash, result.resolution.snapshotHash);
    await assert.rejects(invokeRole({
      ...options, resolution: result.resolution, role: 'implementation', prompt: 'Synthetic test; never a live inference.'
    }), code('MISSING_TELEMETRY'));
    const invocation = JSON.parse(await readFile(path.join(fixture.root, 'invocation.json'), 'utf8'));
    assert.notEqual(invocation.cwd, fixture.root);
    assert.ok(invocation.cwd.includes('/isolated/'));
    assert.ok(invocation.home.includes('/isolated/'));
    assert.equal(invocation.sourceRepositoryVisible, false);
    assert.deepEqual(invocation.contextFiles, ['.git']);
    assert.match(invocation.gitHead, /inert-context/);
    assert.deepEqual(invocation.config, SAFE_CONFIG);
    assert.ok(!invocation.environmentKeys.includes('GH_TOKEN'));
    assert.ok(invocation.args.includes('--available-tools='));
    assert.deepEqual(await readdir(path.join(fixture.root, '.factory', 'isolated')), []);
  } finally {
    if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = previous;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('subprocess telemetry input is bounded, UTF-8, and not a linked file', async () => {
  const previous = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = fixtureToken;
  try {
    for (const [input, expected] of [
      [{ telemetry: [0xc3, 0x28] }, 'INVALID_TELEMETRY'],
      [{ telemetryKind: 'symlink' }, 'UNSAFE_TELEMETRY'],
      [{ telemetryKind: 'hardlink' }, 'UNSAFE_TELEMETRY'],
      [{ telemetryKind: 'oversized' }, 'TELEMETRY_LIMIT']
    ]) {
      const fixture = await mockProject(input);
      try {
        const options = {
          cwd: fixture.root, policy: fixture.policy, catalog: fixture.catalog,
          cliPath: fixture.cliPath, runId: 'unsafe-telemetry', roles: ['implementation']
        };
        const { resolution } = await preflight(options);
        await assert.rejects(invokeRole({
          ...options, resolution, role: 'implementation', prompt: 'Synthetic telemetry input test.'
        }), code(expected));
        assert.deepEqual(await readdir(path.join(fixture.root, '.factory', 'isolated')), []);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = previous;
  }
});
