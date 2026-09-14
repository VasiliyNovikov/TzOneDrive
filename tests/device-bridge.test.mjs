import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ACCEPTANCE_STEPS, VISUAL_CRITERIA } from '../factory/acceptance.mjs';
import { runDevice } from '../factory/device.mjs';
import { advance, createState, validationGate } from '../factory/controller.mjs';
import {
  deviceReceiptForStage, evidenceDigest, isPrivateDeviceReceipt, runPrivateDeviceBridge,
  summarizePrivateDeviceReports, validateDeviceReceipt, validatePrivateDeviceReports,
  validateTestedManifest, verifyPrivateCheckout, verifyWidgetBytes, withPrivateDeviceAttempt,
} from '../factory/device-bridge.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const TESTED = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const NOW = Date.now();
const iso = value => new Date(value).toISOString();

function fixture() {
  // Deliberately synthetic schema data: these fixtures are not real deployment evidence.
  const files = [{ path: 'app/build.json', size: 2, sha256: sha256('{}') }];
  const manifest = { schemaVersion: 1, version: '1.0.0', commit: TESTED, buildId: TESTED,
    mode: 'production', appId: 'TzOneDrive.PhotoViewer', packageId: 'TzOneDrive',
    treeHash: sha256(files.map(file => `${file.path}\0${file.sha256}\n`).join('')), files };
  const state = createState([{ id: 'synthetic-schema', goal: 'Synthetic receipt contract only' }],
    { mode: 'real', now: NOW - 1000 });
  state.activeTaskId = state.tasks[0].id;
  const task = state.tasks[0];
  task.status = 'running';
  task.stage = 'deploy';
  task.intent = { key: 'd'.repeat(64), action: 'deploy', attempt: 1,
    createdAt: NOW - 1000, dispatchCount: 1, pollCount: 0, pending: null };
  task.evidence = {
    implement: { headSha: TESTED }, pr: { headSha: TESTED },
    validate: { verdict: 'PASS', headSha: TESTED, testedSha: TESTED, ciPassed: true,
      independentReview: { verdict: 'PASS', independent: true, reviewer: 'synthetic-reviewer' },
      package: { headSha: TESTED, buildId: TESTED, sha256: manifest.treeHash, manifest } },
    merge: { verdict: 'PASS', merged: true, headSha: TESTED, mergeSha: MERGED },
  };
  const receipt = {
    schemaVersion: 1, kind: 'private-device-evidence', verdict: 'PASS', simulated: false,
    taskId: task.id, runId: state.runId, deployKey: task.intent.key, testedHeadSha: TESTED,
    testedSourceTree: TREE, mergeSha: MERGED, mergedSourceTree: TREE, harnessSha: MERGED,
    testedUnsignedTreeHash: manifest.treeHash, testedManifestSha256: evidenceDigest(manifest),
    buildId: MERGED, unsignedTreeHash: sha256('synthetic merged unsigned tree'),
    manifestSha256: sha256('synthetic merged manifest'), signedPackageSha256: sha256('synthetic signed widget'),
    deviceId: sha256('synthetic device'), deviceMode: 'real', installed: true, launched: true,
    startedAt: iso(NOW - 500), completedAt: iso(NOW),
    deploymentReportSha256: sha256('synthetic deployment report'),
    acceptance: { verdict: 'PASS', source: 'physical-camera', observedCommit: MERGED, observedBuildId: MERGED,
      frameCount: 18, stepCount: 9, evidenceSha256: sha256('synthetic evidence'),
      reportSha256: sha256('synthetic acceptance report') },
  };
  return { state, task, receipt, manifest, context: { task, runId: state.runId, deployKey: task.intent.key, now: NOW } };
}

test('synthetic production-schema fixture separates source trees, unsigned builds and signed widget hashes', () => {
  const { task, receipt, context } = fixture();
  assert.equal(validationGate(task, 'real'), null);
  assert.equal(validateDeviceReceipt(receipt, context), receipt);
  assert.equal(isPrivateDeviceReceipt(receipt), false, 'Schema validation cannot brand synthetic evidence as physical');
  assert.notEqual(receipt.testedHeadSha, receipt.mergeSha);
  assert.notEqual(receipt.testedUnsignedTreeHash, receipt.unsignedTreeHash);
  assert.notEqual(receipt.signedPackageSha256, receipt.unsignedTreeHash);
  assert.equal(receipt.acceptance.observedCommit, receipt.mergeSha);
});

test('production receipts reject stale identities, source/build/hash confusion, modes and private payloads', () => {
  const mutations = [
    value => { value.taskId = 'other'; }, value => { value.runId = 'other'; },
    value => { value.deployKey = 'f'.repeat(64); }, value => { value.testedHeadSha = MERGED; },
    value => { value.mergeSha = TESTED; }, value => { value.mergedSourceTree = 'f'.repeat(40); },
    value => { value.harnessSha = TESTED; }, value => { value.buildId = TESTED; },
    value => { value.testedUnsignedTreeHash = value.signedPackageSha256; },
    value => { value.testedManifestSha256 = value.unsignedTreeHash; },
    value => { value.signedPackageSha256 = value.unsignedTreeHash; },
    value => { value.signedPackageSha256 = 'invalid'; },
    value => { value.deviceMode = 'mock'; }, value => { value.simulated = true; },
    value => { value.installed = false; }, value => { value.launched = false; },
    value => { value.acceptance.observedCommit = TESTED; },
    value => { value.acceptance.observedBuildId = TESTED; },
    value => { value.acceptance.verdict = 'FAIL'; },
    value => { value.acceptance.source = 'screenshot'; },
    value => { value.acceptance.frameCount = 0; },
    value => { value.acceptance.reportSha256 = '/private/report.json'; },
    value => { value.startedAt = iso(NOW - 2000); },
    value => { value.completedAt = iso(NOW + 1); },
    value => { value.camera = '/private/raw.png'; },
    value => { value.goal = 'private operator goal'; },
    value => { value.logs = 'raw output'; },
    value => { value.gateEligible = true; },
  ];
  for (const mutate of mutations) {
    const { receipt, context } = fixture();
    mutate(receipt);
    assert.throws(() => validateDeviceReceipt(receipt, context));
  }
  const { receipt, context } = fixture();
  assert.throws(() => validateDeviceReceipt(receipt, { ...context, now: NOW + 600001 }), /stale/);
});

test('real unsigned validation requires the exact tested HEAD manifest, never a signed hash', () => {
  for (const mutate of [
    artifact => { artifact.sha256 = sha256('signed widget'); },
    artifact => { artifact.manifest.commit = MERGED; },
    artifact => { artifact.manifest.buildId = MERGED; },
    artifact => { artifact.manifest.mode = 'mock'; },
    artifact => { artifact.manifest.files[0].path = 'app/../private'; },
    artifact => { delete artifact.manifest; },
  ]) {
    const { task } = fixture();
    mutate(task.evidence.validate.package);
    assert.throws(() => validateTestedManifest(task.evidence.validate.package, TESTED));
    assert.equal(validationGate(task, 'real'), 'uncorrelated-tested-unsigned-manifest');
  }
});

test('controller cannot turn even coherent test-injected production schema into physical delivery', async () => {
  for (const field of ['goal', 'rawCamera', 'logs']) {
    const { state, receipt } = fixture();
    const result = await advance(state, { execute: async () => ({ ...receipt, [field]: 'DO_NOT_PUBLISH' }) }, { now: NOW });
    assert.equal(result.status, 'blocked');
    assert.equal(result.tasks[0].blockedReason, 'invalid-private-device-receipt');
    assert.ok(!JSON.stringify(result).includes('DO_NOT_PUBLISH'));
  }
  const { state, receipt } = fixture();
  const result = await advance(state, { execute: async () => receipt }, { now: NOW });
  assert.equal(result.status, 'blocked');
  assert.equal(result.tasks[0].delivery, undefined);
  const { task, context } = fixture();
  task.stage = 'accept';
  task.intent = { action: 'accept' };
  task.evidence.deploy = { ...receipt, key: receipt.deployKey, recordedAt: NOW };
  for (const field of ['signedPackageSha256', 'manifestSha256', 'unsignedTreeHash', 'deviceId']) {
    const swapped = { ...receipt, [field]: sha256(`different ${field}`) };
    assert.throws(() => validateDeviceReceipt(swapped, context), /exact private deployment receipt/);
  }
  assert.equal(isPrivateDeviceReceipt(Object.freeze({ ...receipt })), false);
  const failed = await advance(state, { execute: async () => ({ verdict: 'FAIL', simulated: false, rawCamera: 'DO_NOT_PUBLISH' }) }, { now: NOW });
  assert.ok(!JSON.stringify(failed).includes('DO_NOT_PUBLISH'));
});

function reports() {
  const expectedBuild = { commit: MERGED, buildId: MERGED };
  const common = { schemaVersion: 1, mode: 'real', status: 'PASS', publicArtifactsAllowed: false, expectedBuild };
  const deploy = { ...common, operation: 'deploy', startedAt: iso(NOW - 500), completedAt: iso(NOW - 400),
    reasonCode: 'DEPLOYED_NOT_ACCEPTED', gateEligible: false,
    checks: Object.fromEntries(['manifest', 'connected', 'signedPackage', 'installed', 'launched'].map(key => [key, 'PASS'])),
    artifact: { name: 'TzOneDrive.wgt', sha256: sha256('synthetic widget'), synthetic: false } };
  const acceptance = { ...common, operation: 'accept', reasonCode: 'ACCEPTED', gateEligible: true,
    startedAt: iso(NOW - 400), completedAt: iso(NOW), observedBuild: expectedBuild,
    checks: Object.fromEntries(['connected', 'buildIdentity', 'freshFrames', 'readable', 'unobstructed', 'visualAssertions'].map(key => [key, 'PASS'])),
    steps: ACCEPTANCE_STEPS.map(step => ({ id: step.id, verdict: 'PASS',
      criteria: Object.fromEntries(VISUAL_CRITERIA.map(key => [key, true])) })),
    evidence: ACCEPTANCE_STEPS.flatMap((step, index) => ['before', 'after'].map((position, offset) => ({
      id: `${step.id}-${position}`, sha256: sha256(`synthetic frame ${index} ${offset}`),
      capturedAt: iso(NOW - 300 + index * 2 + offset), monotonicNs: String(1 + index * 2 + offset),
      challenge: String(index * 2 + offset).padStart(6, '0'), synthetic: false, format: 'png', bytes: 100,
    }))),
  };
  return { deploy, acceptance, expectedBuild, context: { startedAt: NOW - 500, now: NOW } };
}

test('private report schema positive fixture checks every step and fresh ordered frame, not gateEligible alone', () => {
  const { deploy, acceptance, expectedBuild, context } = reports();
  validatePrivateDeviceReports(deploy, acceptance, expectedBuild, context);
  for (const mutate of [
    report => { report.steps[3].criteria.afterState = false; },
    report => { report.steps[3].criteria.remoteResponse = false; },
    report => { report.evidence = []; },
    report => { report.evidence[0].capturedAt = iso(NOW - 1000); },
    report => { report.evidence[1].sha256 = report.evidence[0].sha256; },
    report => { report.evidence[1].challenge = report.evidence[0].challenge; },
    report => { report.evidence[1].monotonicNs = report.evidence[0].monotonicNs; },
    report => { report.checks.unobstructed = 'INCONCLUSIVE'; },
    report => { report.steps[0].criteria.unobstructed = false; },
    report => { report.mode = 'mock'; },
    report => { report.observedBuild = { commit: TESTED, buildId: TESTED }; },
    report => { report.evidence[0].synthetic = true; },
  ]) {
    const invalid = structuredClone(acceptance);
    mutate(invalid);
    assert.throws(() => validatePrivateDeviceReports(deploy, invalid, expectedBuild, context));
  }
});

function unsuccessfulAcceptance(verdict) {
  const value = reports();
  value.acceptance.status = verdict;
  value.acceptance.gateEligible = false;
  if (verdict === 'FAIL') {
    value.acceptance.reasonCode = 'VISUAL_ASSERTION_FAILED';
    value.acceptance.steps = value.acceptance.steps.slice(0, 4);
    value.acceptance.evidence = value.acceptance.evidence.slice(0, 8);
    Object.assign(value.acceptance.steps[3], { verdict: 'FAIL' });
    Object.assign(value.acceptance.steps[3].criteria, { afterState: false, remoteResponse: false });
    value.acceptance.checks.visualAssertions = 'FAIL';
  } else {
    value.acceptance.reasonCode = 'CAMERA_UNAVAILABLE';
    value.acceptance.observedBuild = null;
    value.acceptance.steps = [];
    value.acceptance.evidence = [];
  }
  return value;
}

test('successful signed deployment remains PASS when nested physical acceptance fails or is unavailable', () => {
  for (const verdict of ['FAIL', 'INCONCLUSIVE']) {
    const { deploy, acceptance, expectedBuild, context: timing } = unsuccessfulAcceptance(verdict);
    const summary = summarizePrivateDeviceReports(deploy, acceptance, expectedBuild, timing);
    assert.equal(summary.verdict, 'PASS');
    assert.equal(summary.acceptance.verdict, verdict);
    assert.equal(summary.signedPackageSha256, deploy.artifact.sha256);
    assert.equal(summary.acceptance.reportSha256, evidenceDigest(acceptance));
    assert.equal(summary.acceptance.observedCommit, null);
    assert.equal(summary.acceptance.observedBuildId, null);
    assert.equal(isPrivateDeviceReceipt(summary), false);
    const { receipt, task, context } = fixture();
    const deployment = { ...receipt, ...summary };
    assert.equal(deviceReceiptForStage(deployment, 'deploy', context), deployment);
    // Seed a synthetic durable install receipt; this test does not grant real producer provenance.
    task.evidence.deploy = { ...deployment, key: deployment.deployKey, recordedAt: NOW };
    task.stage = 'accept';
    task.intent = { action: 'accept' };
    const routed = deviceReceiptForStage(deployment, 'accept', context);
    assert.equal(routed.verdict, verdict);
    assert.equal(routed.signedPackageSha256, deployment.signedPackageSha256);
    assert.deepEqual(routed.acceptance, deployment.acceptance);
    assert.equal(isPrivateDeviceReceipt(routed), false);
    assert.equal(validateDeviceReceipt(routed, context), routed);
    assert.throws(() => validateDeviceReceipt(deployment, context), /identity mismatch/);
    assert.throws(() => validateDeviceReceipt({ ...routed, verdict: 'PASS' }, context));
    assert.throws(() => deviceReceiptForStage({ ...deployment, verdict }, 'accept', context), /successful deployment/);
    assert.throws(() => deviceReceiptForStage(deployment, 'deploy', context), /identity mismatch/);
    delete task.evidence.deploy;
    assert.throws(() => deviceReceiptForStage(deployment, 'accept', context), /recorded successful deployment/);
  }
});

test('routed camera FAIL creates acceptance repair and INCONCLUSIVE retries only acceptance, never install', async () => {
  for (const verdict of ['FAIL', 'INCONCLUSIVE']) {
    const { state, task, receipt } = fixture();
    const { deploy, acceptance, expectedBuild, context: timing } = unsuccessfulAcceptance(verdict);
    const deployment = { ...receipt, ...summarizePrivateDeviceReports(deploy, acceptance, expectedBuild, timing) };
    // Model a durable successful install, not physical evidence fabricated by a test adapter.
    task.stage = 'accept';
    task.intent = null;
    task.attempts.deploy = 1;
    task.evidence.deploy = { ...deployment, key: deployment.deployKey, recordedAt: NOW };
    const actions = [];
    const adapter = { execute(action, current, context) {
      actions.push(action);
      assert.equal(action, 'accept', 'The stored camera outcome must not cause deploy/reinstall');
      return deviceReceiptForStage(deployment, action, {
        task: current, runId: context.runId, deployKey: deployment.deployKey, now: context.now,
      });
    } };
    let result = await advance(state, adapter, { now: NOW });
    assert.equal(result.tasks[0].evidence.deploy.verdict, 'PASS');
    assert.equal(result.tasks[0].evidence.accept.verdict, verdict);
    assert.equal(result.tasks[0].delivery, undefined);
    if (verdict === 'FAIL') {
      assert.equal(result.tasks[0].status, 'repair');
      assert.equal(result.tasks[1].sourceTaskId, task.id);
      assert.equal(result.tasks[1].evidence.repairRequest.reason, 'physical-acceptance-failed');
      assert.equal(result.tasks[0].blockedReason, undefined);
      assert.deepEqual(actions, ['accept']);
    } else {
      assert.equal(result.tasks[0].stage, 'accept');
      assert.equal(result.status, 'waiting');
      while (result.status === 'waiting') result = await advance(result, adapter, { now: result.nextWakeAt });
      assert.equal(result.status, 'blocked');
      assert.equal(result.tasks[0].blockedReason, 'inconclusive-limit');
      assert.equal(result.tasks[0].attempts.deploy, 1);
      assert.equal(result.tasks[0].inconclusive.deploy, undefined);
      assert.deepEqual(actions, ['accept', 'accept', 'accept']);
    }
    assert.ok(result.tasks.every(current => current.delivery === undefined));
  }
});

test('negative acceptance summaries retain privacy and cannot claim a physical PASS gate', () => {
  const { deploy, acceptance, expectedBuild, context } = unsuccessfulAcceptance('FAIL');
  acceptance.observedBuild = { commit: 'PRIVATE_CAMERA_TEXT', buildId: '/private/frame.png' };
  acceptance.reason = 'PRIVATE_CAMERA_TEXT /private/frame.png';
  const summary = summarizePrivateDeviceReports(deploy, acceptance, expectedBuild, context);
  assert.equal(summary.verdict, 'PASS', 'Only the installation passed');
  assert.ok(!JSON.stringify(summary).includes('PRIVATE_CAMERA_TEXT'));
  assert.ok(!JSON.stringify(summary).includes('/private/frame.png'));
  for (const changed of [
    { ...acceptance, gateEligible: true }, { ...acceptance, reasonCode: 'ACCEPTED' },
    { ...acceptance, mode: 'mock' }, { ...acceptance, publicArtifactsAllowed: true },
    { ...acceptance, expectedBuild: { commit: TESTED, buildId: TESTED } },
    { ...acceptance, completedAt: iso(NOW + 1) },
  ]) assert.throws(() => summarizePrivateDeviceReports(deploy, changed, expectedBuild, context));
  for (const status of ['FAIL', 'INCONCLUSIVE']) {
    assert.throws(() => summarizePrivateDeviceReports({ ...deploy, status }, acceptance, expectedBuild, context));
  }
  const good = reports();
  const { receipt, task, context: receiptContext } = fixture();
  const deployment = { ...receipt, ...summarizePrivateDeviceReports(good.deploy, good.acceptance, good.expectedBuild, good.context) };
  task.stage = 'accept';
  task.intent = { action: 'accept' };
  task.evidence.deploy = { ...deployment, key: deployment.deployKey, recordedAt: NOW };
  const routed = deviceReceiptForStage(deployment, 'accept', receiptContext);
  assert.equal(routed.verdict, 'PASS');
  assert.equal(isPrivateDeviceReceipt(routed), false, 'Routing cannot turn synthetic PASS into physical provenance');
  assert.throws(() => deviceReceiptForStage(deployment, 'accept', { ...receiptContext, now: NOW + 600001 }), /stale/);
});

test('actual mock controls remain non-physical and failed evidence cannot satisfy report validation', async t => {
  const directory = resolve('.factory-local', `bridge-controls-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const scenario of ['pass', 'missing-camera', 'obstructed', 'stale-frame', 'navigation-failure']) {
    const config = { mode: 'mock', expectedBuild: { commit: MERGED, buildId: MERGED },
      camera: { outputDir: directory }, mock: { scenario } };
    const report = await runDevice({ operation: 'accept', config });
    assert.equal(report.gateEligible, false);
    assert.equal(report.status === 'PASS', scenario === 'pass');
    const { deploy, expectedBuild, context } = reports();
    assert.throws(() => validatePrivateDeviceReports(deploy, report, expectedBuild, context));
  }
});

function widget(entries) {
  let offset = 0;
  const locals = [];
  const central = [];
  for (const [name, text] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(header, filename, data);
    central.push(entry, filename);
    offset += header.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

test('widget payload is bound to merged unsigned assets and the independently computed signed-byte hash', () => {
  const { manifest } = fixture();
  const entries = [['build.json', '{}'], ['author-signature.xml', '<synthetic/>'], ['signature1.xml', '<synthetic/>']];
  const bytes = widget(entries);
  verifyWidgetBytes(bytes, manifest, sha256(bytes));
  assert.throws(() => verifyWidgetBytes(bytes, manifest, manifest.treeHash), /hash mismatch/);
  for (const changed of [
    entries.slice(0, 2), [['build.json', '[]'], ...entries.slice(1)],
    [...entries, ['../private', 'x']], [...entries, ['build.json', '{}']],
    [...entries, ['unexpected.js', 'x']],
  ]) {
    const invalid = widget(changed);
    assert.throws(() => verifyWidgetBytes(invalid, manifest, sha256(invalid)));
  }
});

test('bridge accepts no injected infrastructure, relative config, mock config, or symlink paths', async t => {
  const directory = resolve(`.factory-bridge-paths-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'operator.json');
  const options = { inputs: { stage: 'deploy' }, configPath };
  for (const field of ['api', 'adapters', 'command', 'env', 'admitted', 'dependencies']) {
    await assert.rejects(runPrivateDeviceBridge({ ...options, [field]: true }), /Only dispatch inputs/);
  }
  await assert.rejects(runPrivateDeviceBridge({ ...options, configPath: '.factory-local/config.json' }), /absolute/);
  await writeFile(configPath, JSON.stringify({ mode: 'mock' }), { mode: 0o600 });
  await assert.rejects(runPrivateDeviceBridge(options), /Real operator configuration/);
  await chmod(configPath, 0o644);
  await assert.rejects(runPrivateDeviceBridge(options), /operator-owned/);
  const link = join(directory, 'linked.json');
  await symlink(configPath, link);
  await assert.rejects(runPrivateDeviceBridge({ ...options, configPath: link }), /Symlink/);
  await assert.rejects(runPrivateDeviceBridge({ ...options, configPath: `${directory}/../operator.json` }), /canonical/);
});

test('bridge verifies its actual checkout rather than trusting a claimed harness SHA', async () => {
  await assert.rejects(verifyPrivateCheckout({ harness: '0'.repeat(40) }), /checkout is not current/);
});

test('private device locking serializes attempts, keeps immutable 0600 receipts, and refuses stale replay', async t => {
  const directory = resolve(`.factory-bridge-lock-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'operator.json');
  await writeFile(configPath, '{}', { mode: 0o600 });
  const request = { configPath, deviceId: sha256('synthetic serial'), deployKey: 'a'.repeat(64) };
  await withPrivateDeviceAttempt(request, async attempt => {
    assert.equal((await lstat(attempt)).mode & 0o777, 0o700);
    assert.equal((await lstat(resolve(attempt, '..'))).mode & 0o777, 0o700);
    const names = await readdir(attempt);
    assert.equal(names.length, 1);
    assert.match(names[0], /^intent-[a-f0-9]{64}\.json$/u);
    assert.equal((await lstat(join(attempt, names[0]))).mode & 0o777, 0o600);
    await assert.rejects(withPrivateDeviceAttempt({ ...request, deployKey: 'b'.repeat(64) },
      () => assert.fail('Physical device must remain locked')), { code: 'EEXIST' });
  });
  await assert.rejects(withPrivateDeviceAttempt(request, () => assert.fail('Cannot replay intent')), { code: 'EEXIST' });
  await assert.rejects(withPrivateDeviceAttempt({ ...request, deployKey: '../escape' },
    () => assert.fail('Cannot traverse')));
  const root = join(directory, 'device-bridge-private');
  const lock = join(root, `device-${request.deviceId}.lock`);
  await symlink(directory, lock);
  await assert.rejects(withPrivateDeviceAttempt({ ...request, deployKey: 'c'.repeat(64) },
    () => assert.fail('Never follow a lock symlink')), { code: 'EEXIST' });
});
