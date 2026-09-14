import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildApp } from '../scripts/build.mjs';
import { EXIT_CODES, parseDeviceArguments, runDevice, verifyBuildManifest } from '../factory/device.mjs';
import { createMockAdapters } from '../factory/adapters/mock.mjs';
import { createRealAdapters, isRealAdapter, parseSdbDevices } from '../factory/adapters/real.mjs';
import { AdapterError, runCommand, runJsonCommand } from '../factory/adapters/process.mjs';

const commit = 'a'.repeat(40);
const expectedBuild = { commit, buildId: commit };
const mockConfig = () => ({ mode: 'mock', expectedBuild: { ...expectedBuild } });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = resolve('.factory-local', `device-test-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function buildFixture(t) {
  const projectRoot = await fixture(t);
  await mkdir(join(projectRoot, 'app'));
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  await writeFile(join(projectRoot, 'app/index.html'), '<body data-build-commit="UNSTAMPED">SOURCE · UNSTAMPED</body>');
  await writeFile(join(projectRoot, 'app/config.xml'), '<widget version="1.0.0"></widget>');
  const manifest = await buildApp({ root: projectRoot, env: { BUILD_ID: commit } });
  return { config: { mode: 'real', projectRoot, expectedBuild }, manifest };
}

test('mock diagnostics pass without claiming deployment or physical acceptance', async () => {
  const report = await runDevice({ operation: 'diagnostics', config: mockConfig() });
  assert.equal(report.status, 'PASS');
  assert.equal(report.reasonCode, 'DIAGNOSTICS_READY');
  assert.equal(report.diagnostics.synthetic, true);
  assert.equal(report.gateEligible, false);
  assert.equal(report.publicArtifactsAllowed, true);
  assert.equal(report.artifact, null);
  assert.deepEqual(report.evidence, []);
  assert.ok(Date.parse(report.completedAt) >= Date.parse(report.startedAt));
});

test('mock deployment prepares, installs and launches the correlated synthetic package in order', async () => {
  const config = mockConfig();
  const adapters = createMockAdapters(config);
  const calls = [];
  let prepared;
  for (const method of ['connect', 'preparePackage', 'install', 'launch']) {
    const original = adapters[method];
    adapters[method] = async (options) => {
      calls.push(method);
      if (method === 'install') assert.equal(options.artifact, prepared);
      const result = await original(options);
      if (method === 'preparePackage') prepared = result;
      return result;
    };
  }
  const report = await runDevice({ operation: 'deploy', config, dependencies: { adapters } });
  assert.equal(report.status, 'PASS');
  assert.equal(report.reasonCode, 'DEPLOYED_NOT_ACCEPTED');
  assert.deepEqual(calls, ['connect', 'preparePackage', 'install', 'launch']);
  assert.deepEqual(report.expectedBuild, expectedBuild);
  assert.deepEqual(report.artifact, {
    name: 'TzOneDrive.wgt', sha256: sha256(JSON.stringify(expectedBuild)), synthetic: true,
  });
  assert.deepEqual(report.checks, {
    manifest: 'PASS', connected: 'PASS', signedPackage: 'PASS', installed: 'PASS', launched: 'PASS',
  });
  assert.equal(report.gateEligible, false);
  assert.deepEqual(report.steps, []);
  assert.deepEqual(report.evidence, []);
  const other = createMockAdapters({ ...config, expectedBuild: { ...expectedBuild, buildId: 'other-package' } });
  assert.notEqual((await other.preparePackage()).sha256, report.artifact.sha256);
});

test('deployment stops on unavailable stages and invalid package metadata', async (t) => {
  const cases = [
    ['disconnected', 'connect', false, 'DISCONNECTED'],
    ['missing package', 'preparePackage', null, 'INVALID_PACKAGE'],
    ['invalid hash', 'preparePackage', { sha256: 'invalid', synthetic: true }, 'INVALID_PACKAGE'],
    ['non-synthetic mock package', 'preparePackage', { sha256: 'b'.repeat(64), synthetic: false }, 'INVALID_PACKAGE'],
    ['install failure', 'install', false, 'INSTALL_FAILED'],
    ['launch failure', 'launch', false, 'LAUNCH_FAILED'],
  ];
  for (const [name, failedMethod, result, reasonCode] of cases) await t.test(name, async () => {
    const config = mockConfig();
    const adapters = createMockAdapters(config);
    const methods = ['connect', 'preparePackage', 'install', 'launch'];
    const calls = [];
    for (const method of methods) {
      const original = adapters[method];
      adapters[method] = async (options) => {
        calls.push(method);
        return method === failedMethod ? result : original(options);
      };
    }
    const report = await runDevice({ operation: 'deploy', config, dependencies: { adapters } });
    assert.equal(report.status, 'INCONCLUSIVE');
    assert.equal(report.reasonCode, reasonCode);
    assert.equal(report.gateEligible, false);
    assert.deepEqual(calls, methods.slice(0, methods.indexOf(failedMethod) + 1));
  });
});

test('production manifest verification accepts the build script output', async (t) => {
  const { config, manifest } = await buildFixture(t);
  assert.deepEqual(await verifyBuildManifest(config), manifest);
});

test('manifest verification binds both independently requested build identifiers', async (t) => {
  for (const mismatch of [{ commit: 'b'.repeat(40) }, { buildId: 'other-package' }]) {
    await t.test(Object.keys(mismatch)[0], async (t) => {
      const { config } = await buildFixture(t);
      const requested = { ...expectedBuild, ...mismatch };
      await assert.rejects(verifyBuildManifest(config, requested), { code: 'BUILD_MISMATCH' });
      const connect = t.mock.fn();
      const report = await runDevice({
        operation: 'deploy', config, expectedBuild: requested,
        dependencies: { adapters: { mode: 'real', synthetic: false, connect } },
      });
      assert.equal(report.status, 'FAIL');
      assert.equal(report.reasonCode, 'BUILD_MISMATCH');
      assert.deepEqual(report.expectedBuild, requested);
      assert.equal(report.gateEligible, false);
      assert.equal(connect.mock.callCount(), 0);
    });
  }
});

test('manifest verification rejects changed assets, unlisted files and mismatched tree hashes', async (t) => {
  const cases = [
    ['changed bytes', async ({ config }) => {
      const path = join(config.projectRoot, 'dist/app/index.html');
      const bytes = await readFile(path);
      bytes[0] ^= 1;
      await writeFile(path, bytes);
    }],
    ['changed size', async ({ config }) => {
      await writeFile(join(config.projectRoot, 'dist/app/index.html'), 'changed');
    }],
    ['unlisted file', async ({ config }) => {
      await writeFile(join(config.projectRoot, 'dist/app/extra.js'), 'extra');
    }],
    ['tree hash', async ({ manifest }) => { manifest.treeHash = '0'.repeat(64); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async (t) => {
    const built = await buildFixture(t);
    await mutate(built);
    await writeFile(join(built.config.projectRoot, 'dist/manifest.json'), JSON.stringify(built.manifest));
    await assert.rejects(verifyBuildManifest(built.config), { code: 'ARTIFACT_MISMATCH' });
  });
});

test('a self-consistent asset hash cannot hide a different packaged build identity', async (t) => {
  const { config, manifest } = await buildFixture(t);
  const path = join(config.projectRoot, 'dist/app/build.json');
  const identity = JSON.parse(await readFile(path, 'utf8'));
  const bytes = Buffer.from(JSON.stringify({ ...identity, buildId: 'other-package' }));
  await writeFile(path, bytes);
  Object.assign(manifest.files.find((file) => file.path === 'app/build.json'), {
    size: bytes.length, sha256: sha256(bytes),
  });
  manifest.treeHash = sha256(manifest.files.map((file) => `${file.path}\0${file.sha256}\n`).join(''));
  await writeFile(join(config.projectRoot, 'dist/manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyBuildManifest(config), { code: 'BUILD_MISMATCH' });
});

test('real adapter instances are frozen and only production process functions receive real identity', async (t) => {
  const command = t.mock.fn();
  const jsonCommand = t.mock.fn();
  for (const [name, dependencies, branded] of [
    ['default processes', {}, true],
    ['explicit production processes', { command: runCommand, jsonCommand: runJsonCommand }, true],
    ['injected command', { command }, false],
    ['injected JSON command', { jsonCommand }, false],
    ['both injected', { command, jsonCommand }, false],
  ]) await t.test(name, () => {
    const adapters = createRealAdapters({}, dependencies);
    assert.equal(adapters.mode, 'real');
    assert.equal(adapters.synthetic, false);
    assert.equal(Object.isFrozen(adapters), true);
    assert.equal(isRealAdapter(adapters), branded);
    assert.equal(isRealAdapter({ ...adapters }), false);
    assert.equal(isRealAdapter(Object.create(adapters)), false);
    assert.throws(() => { adapters.synthetic = true; }, TypeError);
  });
  const mock = createMockAdapters(mockConfig());
  assert.equal(isRealAdapter(mock), false);
  Object.assign(mock, { mode: 'real', synthetic: false });
  assert.equal(isRealAdapter(Object.freeze(mock)), false);
  assert.equal(command.mock.callCount(), 0);
  assert.equal(jsonCommand.mock.callCount(), 0);
});

test('visual preflight forwards the configured operator options to the injected worker', async (t) => {
  const projectRoot = await fixture(t);
  const visual = {
    policyPath: join(projectRoot, 'fixture-policy.json'),
    catalogPath: join(projectRoot, 'fixture-catalog.json'),
    cliPath: process.execPath,
  };
  const command = t.mock.fn();
  const jsonCommand = t.mock.fn(async () => ({
    ok: true, result: { resolution: { roles: { visual: { modelId: 'fixture-only' } } } },
  }));
  const adapters = createRealAdapters({
    projectRoot, visual, privacy: { allowCameraInference: true },
    executables: { remote: process.execPath, buildDetector: process.execPath },
    timeouts: { inferenceMs: 1234 },
  }, { command, jsonCommand });
  const signal = new AbortController().signal;
  assert.equal(await adapters.visualReady({ signal }), true);
  assert.equal(jsonCommand.mock.callCount(), 1);
  assert.deepEqual(jsonCommand.mock.calls[0].arguments, [
    process.execPath, [resolve('factory/adapters/visual-worker.mjs')],
    { operation: 'preflight', options: { cwd: projectRoot, ...visual } },
    { signal, timeoutMs: 1234, cwd: projectRoot },
  ]);
  assert.equal(command.mock.callCount(), 0);
  assert.equal(isRealAdapter(adapters), false);
});

test('real diagnostics fail closed on missing local prerequisites without invoking installed tools', async (t) => {
  const command = t.mock.fn(async () => { throw new AdapterError('UNAVAILABLE', 'Fixture executable unavailable'); });
  const config = { mode: 'real' };
  const adapters = createRealAdapters(config, { command });
  const report = await runDevice({ operation: 'diagnostics', config, dependencies: { adapters } });
  assert.equal(report.status, 'INCONCLUSIVE');
  assert.equal(report.reasonCode, 'BOOTSTRAP_REQUIRED');
  for (const key of ['sdkAvailable', 'sdbAvailable', 'ffmpegAvailable', 'cameraAvailable', 'remoteAvailable', 'detectorAvailable']) {
    assert.equal(report.diagnostics[key], false);
  }
  assert.equal(command.mock.callCount(), 3);
  assert.equal(report.gateEligible, false);
  assert.equal(report.publicArtifactsAllowed, false);
});

test('real adapter prerequisites reject missing consent, pairing, signing and decoder configuration', async (t) => {
  const cases = [
    ['camera consent', { executables: { remote: process.execPath, buildDetector: process.execPath } },
      (adapters) => adapters.visualReady(), 'CAMERA_CONSENT_REQUIRED'],
    ['visual policy', { privacy: { allowCameraInference: true }, executables: { remote: process.execPath, buildDetector: process.execPath } },
      (adapters) => adapters.visualReady(), 'INFERENCE_UNAVAILABLE'],
    ['remote pairing', {}, (adapters) => adapters.remote({ key: 'ENTER' }), 'REMOTE_BOOTSTRAP_REQUIRED'],
    ['signing profile', {}, (adapters) => adapters.preparePackage(), 'INVALID_CONFIG'],
    ['build decoder', {}, (adapters) => adapters.detectBuild({ requestId: 'fixture' }), 'INVALID_CONFIG'],
    ['remote allowlist', {}, (adapters) => adapters.remote({ key: 'POWER' }), 'INVALID_ACTION'],
  ];
  for (const [name, config, operation, code] of cases) await t.test(name, async (t) => {
    const command = t.mock.fn();
    const jsonCommand = t.mock.fn();
    const adapters = createRealAdapters(config, { command, jsonCommand });
    await assert.rejects(operation(adapters), { code });
    assert.equal(command.mock.callCount(), 0);
    assert.equal(jsonCommand.mock.callCount(), 0);
  });
});

test('SDB connection requires the exact configured serial in the device state', async (t) => {
  const output = 'List of devices attached\n* daemon started successfully *\nother device Other TV\nfixture offline Offline TV\npending unauthorized\n';
  assert.deepEqual(parseSdbDevices(output), [
    { serial: 'other', state: 'device', name: 'Other TV' },
    { serial: 'fixture', state: 'offline', name: 'Offline TV' },
    { serial: 'pending', state: 'unauthorized', name: '' },
  ]);
  const command = t.mock.fn(async () => ({ stdout: output }));
  const adapters = createRealAdapters({ device: { serial: 'fixture' } }, { command });
  assert.equal(await adapters.checkConnection(), false);
  assert.deepEqual(command.mock.calls[0].arguments.slice(0, 2), ['sdb', ['devices']]);
});

test('device deadlines abort stalled diagnostics and deployment operations', { timeout: 5000 }, async (t) => {
  for (const [operation, method] of [['diagnostics', 'diagnostics'], ['deploy', 'connect']]) {
    await t.test(operation, async () => {
      let signal;
      const config = { ...mockConfig(), timeouts: { operationMs: 20, totalMs: 50 } };
      const adapters = createMockAdapters(config);
      adapters[method] = (options) => {
        signal = options.signal;
        return new Promise(() => {});
      };
      const report = await runDevice({ operation, config, dependencies: { adapters } });
      assert.equal(report.status, 'INCONCLUSIVE');
      assert.equal(report.reasonCode, 'TIMEOUT');
      assert.equal(report.gateEligible, false);
      assert.equal(signal.aborted, true);
    });
  }
});

test('device arguments require an explicit config and complete, non-duplicate build override', () => {
  assert.deepEqual(parseDeviceArguments(['deploy', '--config', 'device.json', '--expected-commit', commit, '--expected-build-id', 'fixture']), {
    operation: 'deploy', configPath: 'device.json', commit, buildId: 'fixture',
  });
  for (const args of [
    [], ['deploy'], ['accept', '--config', 'device.json', '--expected-commit', commit],
    ['accept', '--config', 'device.json', '--config', 'other.json'],
    ['accept', '--config', 'device.json', '--unknown', 'value'],
  ]) assert.throws(() => parseDeviceArguments(args), { code: 'USAGE' });
  assert.deepEqual(EXIT_CODES, { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 });
});

test('process adapters bound child failures, output, cancellation and invalid JSON', { timeout: 10000 }, async (t) => {
  const options = { timeoutMs: 5000, env: {} };
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'literal; argument'], options);
  assert.deepEqual(result, { stdout: 'literal; argument', stderr: '', code: 0 });
  assert.deepEqual(await runJsonCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { fixture: true }, options), { fixture: true });
  for (const [name, source, extra, code] of [
    ['nonzero exit', 'process.exit(7)', {}, 'COMMAND_FAILED'],
    ['stdout limit', 'process.stdout.write("x".repeat(1024))', { maxOutputBytes: 64 }, 'OUTPUT_LIMIT'],
    ['stderr limit', 'process.stderr.write("x".repeat(1024))', { maxOutputBytes: 64 }, 'OUTPUT_LIMIT'],
    ['deadline', 'setInterval(() => {}, 1000)', { timeoutMs: 25 }, 'TIMEOUT'],
  ]) await t.test(name, async () => {
    await assert.rejects(runCommand(process.execPath, ['-e', source], { ...options, ...extra }), { code });
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    ...options, signal: controller.signal,
  }), { code: 'TIMEOUT' });
  const directory = await fixture(t);
  await assert.rejects(runCommand(join(directory, 'missing-executable'), [], options), { code: 'UNAVAILABLE' });
  await assert.rejects(runJsonCommand(process.execPath, ['-e', 'console.log("{}\\n{}")'], {}, options), { code: 'INVALID_RESPONSE' });
  assert.throws(() => runCommand(process.execPath, ['bad\0argument']), { code: 'INVALID_ARGUMENT' });
});
