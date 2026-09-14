import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { buildApp } from '../scripts/build.mjs';
import { ACCEPTANCE_STEPS, VISUAL_CRITERIA } from './acceptance.mjs';
import { AdapterError, exactKeys, runCommand } from './adapters/process.mjs';
import { runDevice, verifyBuildManifest } from './device.mjs';
import { GitHubAPI } from './github-api.mjs';
import { authorizeDispatch } from './github-adapter.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, '');
const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const hash = value => createHash('sha256').update(value).digest('hex');
export const evidenceDigest = value => hash(`${JSON.stringify(value)}\n`);
const fail = message => { throw new AdapterError('PRIVATE_DEVICE_REJECTED', message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MAX_AGE_MS = 10 * 60 * 1000;
// Serialization intentionally loses provenance; loading operator JSON is not a trusted transport.
const privateReceipts = new WeakSet();

export function isPrivateDeviceReceipt(receipt) {
  return privateReceipts.has(receipt);
}

// The worker's legacy package.sha256 is an UNSIGNED asset-tree hash, never a widget hash.
export function validateTestedManifest(artifact, head) {
  const manifest = artifact?.manifest;
  if (!SHA.test(head ?? '') || artifact?.headSha !== head || artifact.buildId !== head ||
      !exactKeys(manifest, ['schemaVersion', 'version', 'commit', 'buildId', 'mode',
        'appId', 'packageId', 'treeHash', 'files']) ||
      manifest.schemaVersion !== 1 || manifest.commit !== head || manifest.buildId !== head ||
      manifest.mode !== 'production' || manifest.appId !== 'TzOneDrive.PhotoViewer' ||
      manifest.packageId !== 'TzOneDrive' || !/^\d+\.\d+\.\d+$/u.test(manifest.version) ||
      !HASH.test(manifest.treeHash) || artifact.sha256 !== manifest.treeHash ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 2000) {
    fail('Tested unsigned manifest identity mismatch');
  }
  const paths = new Set();
  let bytes = 0;
  for (const file of manifest.files) {
    if (!exactKeys(file, ['path', 'size', 'sha256']) || typeof file.path !== 'string' ||
        !/^app\/[A-Za-z0-9_./-]+$/u.test(file.path) ||
        file.path.split('/').some(part => !part || part === '.' || part === '..') ||
        paths.has(file.path) || !HASH.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 20 * 1024 * 1024) {
      fail('Invalid tested unsigned asset manifest');
    }
    paths.add(file.path);
    bytes += file.size;
  }
  if (bytes > 128 * 1024 * 1024 || !paths.has('app/build.json') ||
      hash(manifest.files.map(file => `${file.path}\0${file.sha256}\n`).join('')) !== manifest.treeHash) {
    fail('Tested unsigned asset-tree hash mismatch');
  }
  return manifest;
}

// Verify the widget payload, not XML-signature trust. Signing remains the trusted SDK's job.
export function verifyWidgetBytes(bytes, manifest, signedSha256) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 256 * 1024 * 1024 ||
      hash(bytes) !== signedSha256) fail('Signed widget hash mismatch');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) ||
      bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) fail('Invalid widget ZIP');
  const count = bytes.readUInt16LE(end + 10);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (!count || count > 4004 || centralStart + bytes.readUInt32LE(end + 12) !== end) fail('Invalid widget directory');
  const expected = new Map(manifest.files.map(file => [file.path.slice(4), file]));
  const seen = new Set();
  let cursor = centralStart;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid widget entry');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameSize + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const unixType = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    if (next > end || !nameSize || flags & 1 || ![0, 8].includes(method) ||
        size > 20 * 1024 * 1024 || local + 30 > centralStart ||
        bytes.readUInt32LE(local) !== 0x04034b50) fail('Unsafe widget entry');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    const directory = name.endsWith('/');
    if (!/^[A-Za-z0-9_./-]+$/u.test(name) || seen.has(name) ||
        name.replace(/\/$/u, '').split('/').some(part => !part || part === '.' || part === '..') ||
        ![0, directory ? 0x4000 : 0x8000].includes(unixType)) fail('Unsafe widget path');
    const localNameSize = bytes.readUInt16LE(local + 26);
    const start = local + 30 + localNameSize + bytes.readUInt16LE(local + 28);
    if (start + compressed > centralStart ||
        bytes.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== name ||
        bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags) {
      fail('Widget local/central directory mismatch');
    }
    total += size;
    if (total > 128 * 1024 * 1024) fail('Widget exceeds uncompressed size limit');
    const data = bytes.subarray(start, start + compressed);
    const decoded = method === 0 ? data : inflateRawSync(data, { maxOutputLength: size || 1 });
    if (decoded.length !== size) fail('Widget asset size mismatch');
    if (directory) {
      if (size !== 0) fail('Invalid widget directory payload');
    } else if (['author-signature.xml', 'signature1.xml'].includes(name)) {
      if (!size || size > 1024 * 1024) fail('Missing SDK signature payload');
    } else {
      const file = expected.get(name);
      if (!file || size !== file.size || hash(decoded) !== file.sha256) fail('Signed widget differs from unsigned merged manifest');
    }
    seen.add(name);
    cursor = next;
  }
  if (cursor !== end || [...expected.keys(), 'author-signature.xml', 'signature1.xml'].some(name => !seen.has(name))) {
    fail('Signed widget is incomplete');
  }
}

export function validatePrivateDeviceReports(deploy, acceptance, expected, { startedAt, now }) {
  for (const [report, operation] of [[deploy, 'deploy'], [acceptance, 'accept']]) {
    const start = Date.parse(report?.startedAt);
    const end = Date.parse(report?.completedAt);
    if (report?.schemaVersion !== 1 || report.operation !== operation || report.mode !== 'real' ||
        report.status !== 'PASS' || report.publicArtifactsAllowed !== false ||
        !same(report.expectedBuild, expected) || !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) || start < startedAt || end < start || end > now ||
        now - end > MAX_AGE_MS || end - start > MAX_AGE_MS) fail('Invalid or stale private device report');
  }
  if (deploy.reasonCode !== 'DEPLOYED_NOT_ACCEPTED' || deploy.gateEligible !== false ||
      !['manifest', 'connected', 'signedPackage', 'installed', 'launched'].every(key => deploy.checks?.[key] === 'PASS') ||
      !exactKeys(deploy.artifact, ['name', 'sha256', 'synthetic']) ||
      deploy.artifact.name !== 'TzOneDrive.wgt' || !HASH.test(deploy.artifact.sha256) ||
      deploy.artifact.synthetic !== false) fail('Deployment did not install a concrete signed widget');
  if (Date.parse(acceptance.startedAt) < Date.parse(deploy.completedAt) ||
      acceptance.reasonCode !== 'ACCEPTED' || acceptance.gateEligible !== true ||
      !same(acceptance.observedBuild, expected) ||
      !['connected', 'buildIdentity', 'freshFrames', 'readable', 'unobstructed', 'visualAssertions']
        .every(key => acceptance.checks?.[key] === 'PASS') ||
      acceptance.steps?.length !== ACCEPTANCE_STEPS.length ||
      acceptance.evidence?.length !== ACCEPTANCE_STEPS.length * 2) fail('Physical acceptance is incomplete');
  for (const [index, step] of acceptance.steps.entries()) {
    if (step.id !== ACCEPTANCE_STEPS[index].id || step.verdict !== 'PASS' ||
        !exactKeys(step.criteria, VISUAL_CRITERIA) ||
        VISUAL_CRITERIA.some(key => step.criteria[key] !== true)) fail('Physical navigation did not pass');
  }
  const hashes = new Set();
  const challenges = new Set();
  let monotonic = -1n;
  let captured = Date.parse(acceptance.startedAt);
  for (const [index, frame] of acceptance.evidence.entries()) {
    const step = ACCEPTANCE_STEPS[Math.floor(index / 2)];
    const at = Date.parse(frame.capturedAt);
    if (frame.id !== `${step.id}-${index % 2 ? 'after' : 'before'}` ||
        frame.synthetic !== false || !HASH.test(frame.sha256) || hashes.has(frame.sha256) ||
        !/^\d{6}$/u.test(frame.challenge) || challenges.has(frame.challenge) ||
        !/^\d{1,30}$/u.test(frame.monotonicNs) || BigInt(frame.monotonicNs) <= monotonic ||
        !Number.isSafeInteger(at) || at < captured || at > Date.parse(acceptance.completedAt) ||
        !['png', 'jpeg'].includes(frame.format) || !Number.isSafeInteger(frame.bytes) ||
        frame.bytes < 16 || frame.bytes > 20 * 1024 * 1024) fail('Missing, reused or stale physical frame');
    hashes.add(frame.sha256);
    challenges.add(frame.challenge);
    monotonic = BigInt(frame.monotonicNs);
    captured = at;
  }
}

// This is a schema/correlation check, NOT authentication or external runner admission.
// A future trusted transport must authenticate the producer before using this receipt.
export function validateDeviceReceipt(receipt, { task, runId, deployKey, now }) {
  const fields = ['schemaVersion', 'kind', 'verdict', 'simulated', 'taskId', 'runId', 'deployKey',
    'testedHeadSha', 'testedSourceTree', 'mergeSha', 'mergedSourceTree', 'harnessSha',
    'testedUnsignedTreeHash', 'testedManifestSha256', 'buildId', 'unsignedTreeHash',
    'manifestSha256', 'signedPackageSha256', 'deviceId', 'deviceMode', 'installed', 'launched',
    'startedAt', 'completedAt', 'deploymentReportSha256', 'acceptance'];
  const manifest = validateTestedManifest(task.evidence.validate?.package, task.evidence.validate?.testedSha);
  if (!exactKeys(receipt, fields) || receipt.schemaVersion !== 1 ||
      receipt.kind !== 'private-device-evidence' || receipt.verdict !== 'PASS' ||
      receipt.simulated !== false || receipt.taskId !== task.id || receipt.runId !== runId ||
      !HASH.test(deployKey ?? '') || receipt.deployKey !== deployKey ||
      receipt.testedHeadSha !== manifest.commit || receipt.mergeSha !== task.evidence.merge?.mergeSha ||
      task.evidence.merge?.merged !== true || task.evidence.merge.headSha !== manifest.commit ||
      !SHA.test(receipt.mergeSha) || !SHA.test(receipt.testedSourceTree) ||
      receipt.mergedSourceTree !== receipt.testedSourceTree || receipt.harnessSha !== receipt.mergeSha ||
      receipt.testedUnsignedTreeHash !== manifest.treeHash ||
      receipt.testedManifestSha256 !== evidenceDigest(manifest) ||
      receipt.buildId !== receipt.mergeSha || receipt.deviceMode !== 'real' ||
      receipt.installed !== true || receipt.launched !== true ||
      receipt.signedPackageSha256 === receipt.unsignedTreeHash ||
      receipt.signedPackageSha256 === receipt.testedUnsignedTreeHash ||
      !['unsignedTreeHash', 'manifestSha256', 'signedPackageSha256', 'deviceId', 'deploymentReportSha256']
        .every(key => HASH.test(receipt[key] ?? ''))) fail('Private receipt identity mismatch');
  const start = Date.parse(receipt.startedAt);
  const end = Date.parse(receipt.completedAt);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      (task.intent?.action === 'deploy' && !Number.isSafeInteger(task.intent.createdAt)) ||
      start < (task.intent?.action === 'deploy' ? task.intent.createdAt : task.createdAt) ||
      end < start || end > now || now - end > MAX_AGE_MS || end - start > 2 * MAX_AGE_MS) {
    fail('Private receipt is stale or predates its intent');
  }
  const accepted = receipt.acceptance;
  if (!exactKeys(accepted, ['verdict', 'source', 'observedCommit', 'observedBuildId', 'frameCount',
    'stepCount', 'evidenceSha256', 'reportSha256']) ||
      accepted.verdict !== 'PASS' || accepted.source !== 'physical-camera' ||
      accepted.observedCommit !== receipt.mergeSha || accepted.observedBuildId !== receipt.buildId ||
      accepted.frameCount !== ACCEPTANCE_STEPS.length * 2 || accepted.stepCount !== ACCEPTANCE_STEPS.length ||
      !HASH.test(accepted.evidenceSha256 ?? '') || !HASH.test(accepted.reportSha256 ?? '')) {
    fail('Private receipt lacks correlated physical acceptance');
  }
  if (task.evidence.deploy && task.intent?.action !== 'deploy') {
    const { key, recordedAt, ...deployment } = task.evidence.deploy;
    if (!same(receipt, deployment)) fail('Acceptance must use the exact private deployment receipt');
  }
  return receipt;
}

async function checkedPath(path, { directory = false, privateMode = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || path.includes('\0')) {
    fail('An absolute canonical operator path is required');
  }
  let current = sep;
  for (const segment of path.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (current !== path && !info.isDirectory())) fail('Symlink paths are forbidden');
    if (info.mode & 0o022) fail('Operator paths must not be writable by other users');
  }
  const info = await lstat(path);
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid() ||
      (info.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
      (!directory && (info.nlink !== 1 || info.size > 256 * 1024 * 1024))) fail('Unsafe operator-owned file or directory');
  return info;
}

async function privateDirectory(path, exclusive = false) {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (exclusive || error.code !== 'EEXIST') throw error; }
  await checkedPath(path, { directory: true, privateMode: true });
}

async function saveReport(directory, kind, report) {
  const digest = evidenceDigest(report);
  const file = await open(join(directory, `${kind}-${digest}.json`),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${JSON.stringify(report)}\n`); await file.sync(); }
  finally { await file.close(); }
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  return digest;
}

export async function withPrivateDeviceAttempt({ configPath, deviceId, deployKey }, operation) {
  if (!HASH.test(deviceId ?? '') || !HASH.test(deployKey ?? '')) fail('Invalid private device/intent identity');
  await checkedPath(configPath, { privateMode: true });
  await checkedPath(dirname(configPath), { directory: true, privateMode: true });
  const privateRoot = join(dirname(configPath), 'device-bridge-private');
  await privateDirectory(privateRoot);
  const lock = join(privateRoot, `device-${deviceId}.lock`);
  await privateDirectory(lock, true);
  try {
    const directory = join(privateRoot, `intent-${deployKey}`);
    // Existing/incomplete attempts require reconciliation, never blind physical replay.
    await privateDirectory(directory, true);
    await saveReport(directory, 'intent', { deployKey, deviceId });
    return await operation(directory);
  } finally {
    await rmdir(lock);
  }
}

async function git(args) {
  return (await runCommand('/usr/bin/git', ['--no-replace-objects', ...args], {
    cwd: ROOT, env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    maxOutputBytes: 1024 * 1024,
  })).stdout;
}

export async function verifyPrivateCheckout(context) {
  await checkedPath(ROOT, { directory: true });
  if ((await git(['rev-parse', '--show-toplevel'])).trim() !== ROOT ||
      (await git(['rev-parse', 'HEAD'])).trim() !== context.harness) fail('Executing harness checkout is not current');
  const tested = context.task.evidence.validate.testedSha;
  const trees = await Promise.all([tested, context.head].map(sha => git(['rev-parse', `${sha}^{tree}`])));
  if (!SHA.test(trees[0].trim()) || trees[0] !== trees[1]) fail('Local tested and merged source trees differ');
  const [remoteTested, remoteMerged] = context.sourceTrees;
  if (trees[0].trim() !== remoteTested || trees[1].trim() !== remoteMerged) fail('Local source tree differs from GitHub');
  const entries = (await git(['ls-tree', '-r', '-z', context.harness, '--',
    'factory', 'scripts', 'app', 'package.json', 'package-lock.json'])).split('\0').filter(Boolean);
  const tracked = new Set();
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
    if (!match || match[3].split('/').some(part => !part || part === '.' || part === '..')) fail('Unsafe harness entry');
    const [, mode, expected, name] = match;
    const target = join(ROOT, name);
    const info = await checkedPath(target);
    if (Boolean(info.mode & 0o111) !== (mode === '100755') ||
        (await git(['hash-object', '--no-filters', '--', target])).trim() !== expected) {
      fail('Executing harness or source differs from the trusted commit');
    }
    tracked.add(name);
  }
  async function inspect(directory) {
    for (const entry of await readdir(join(ROOT, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await inspect(name);
      else if (!entry.isFile() || !tracked.has(name)) fail('Untracked executable or application input');
    }
  }
  for (const directory of ['factory', 'scripts', 'app']) await inspect(directory);
  return { testedSourceTree: trees[0].trim(), mergedSourceTree: trees[1].trim() };
}

/**
 * Local orchestration only. The caller must already be on an independently admitted,
 * isolated trusted deployment host, with authentic dispatch environment/credentials,
 * exclusive control of the checkout and one canonical config per physical device.
 * This library does not admit a runner, authenticate a handoff, publish results, or
 * enable factory-device.yml. There is deliberately no HTTP endpoint or admission flag.
 */
export async function runPrivateDeviceBridge(options) {
  if (!exactKeys(options, ['inputs', 'configPath'])) fail('Only dispatch inputs and an operator config path are accepted');
  const { inputs, configPath } = options;
  if (inputs?.stage !== 'deploy') fail('A current deployment intent is required');
  await checkedPath(dirname(configPath), { directory: true, privateMode: true });
  const info = await checkedPath(configPath, { privateMode: true });
  if (info.size > 1024 * 1024) fail('Operator configuration exceeds its bound');
  const operator = JSON.parse(await readFile(configPath, 'utf8'));
  if (operator.mode !== 'real' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operator.device?.serial ?? '') ||
      ['projectRoot', 'appDir', 'manifestPath', 'expectedBuild', 'packageName', 'dependencies', 'adapters', 'mock']
        .some(key => Object.hasOwn(operator, key))) fail('Real operator configuration cannot override build identity or adapters');
  // No API, adapter, command, clock, or authorization dependency injection in this entrypoint.
  const api = new GitHubAPI({ token: process.env.FACTORY_READ_TOKEN });
  const authorize = () => authorizeDispatch(api, inputs);
  let context = await authorize();
  const identity = value => evidenceDigest({ runId: value.state.runId, taskId: value.task.id,
    goalHash: value.task.goalHash, evidence: value.task.evidence,
    key: value.task.intent.key, createdAt: value.task.intent.createdAt, inputs });
  const initialIdentity = identity(context);
  const reauthorize = async () => {
    const current = await authorize();
    if (identity(current) !== initialIdentity) {
      fail('Durable intent changed during private device execution');
    }
    context = current;
  };
  const trees = await verifyPrivateCheckout(context);
  const deviceId = hash(operator.device.serial);
  const deployKey = context.task.intent.key;
  return withPrivateDeviceAttempt({ configPath, deviceId, deployKey }, async directory => {
    const startedAt = Date.now();
    await saveReport(directory, 'dispatch', { inputs, deployKey, startedAt, deviceId });
    await cp(join(ROOT, 'app'), join(directory, 'app'), { recursive: true });
    await cp(join(ROOT, 'package.json'), join(directory, 'package.json'));
    const expectedTested = validateTestedManifest(context.task.evidence.validate.package, context.task.evidence.validate.testedSha);
    const tested = await buildApp({ root: directory, env: { BUILD_ID: expectedTested.commit } });
    if (!same(tested, expectedTested)) fail('Rebuilt tested manifest differs from the independently validated unsigned artifact');
    await saveReport(directory, 'tested-manifest', tested);
    const merged = await buildApp({ root: directory, env: { BUILD_ID: inputs.head } });
    const manifestSha256 = await saveReport(directory, 'merged-manifest', merged);
    const expectedBuild = { commit: inputs.head, buildId: merged.buildId };
    const config = { ...operator, projectRoot: directory, expectedBuild,
      camera: { ...operator.camera, outputDir: join(directory, 'camera') } };
    await privateDirectory(config.camera.outputDir);
    await verifyBuildManifest(config);
    await reauthorize();
    await verifyPrivateCheckout(context);
    const deploy = await runDevice({ operation: 'deploy', config });
    const deploymentReportSha256 = await saveReport(directory, 'deployment', deploy);
    if (deploy.status !== 'PASS') return { verdict: deploy.status, simulated: false,
      reasonCode: 'PRIVATE_DEPLOYMENT_NOT_ACCEPTED', reportSha256: deploymentReportSha256 };
    const packagePath = join(directory, 'dist/app/TzOneDrive.wgt');
    await checkedPath(packagePath);
    verifyWidgetBytes(await readFile(packagePath), merged, deploy.artifact?.sha256);
    await reauthorize();
    const acceptance = await runDevice({ operation: 'accept', config });
    const reportSha256 = await saveReport(directory, 'acceptance', acceptance);
    if (acceptance.status !== 'PASS') return { verdict: acceptance.status, simulated: false,
      reasonCode: 'PRIVATE_ACCEPTANCE_NOT_PASSED', reportSha256 };
    await reauthorize();
    await verifyPrivateCheckout(context);
    await checkedPath(packagePath);
    verifyWidgetBytes(await readFile(packagePath), merged, deploy.artifact?.sha256);
    const completedAt = Date.now();
    validatePrivateDeviceReports(deploy, acceptance, expectedBuild, { startedAt, now: completedAt });
    const receipt = {
      schemaVersion: 1, kind: 'private-device-evidence', verdict: 'PASS', simulated: false,
      taskId: context.task.id, runId: context.state.runId, deployKey,
      testedHeadSha: tested.commit, ...trees, mergeSha: inputs.head, harnessSha: inputs.harness,
      testedUnsignedTreeHash: tested.treeHash, testedManifestSha256: evidenceDigest(tested),
      buildId: merged.buildId, unsignedTreeHash: merged.treeHash, manifestSha256,
      signedPackageSha256: deploy.artifact.sha256, deviceId, deviceMode: 'real', installed: true, launched: true,
      startedAt: new Date(startedAt).toISOString(), completedAt: new Date(completedAt).toISOString(),
      deploymentReportSha256,
      acceptance: { verdict: 'PASS', source: 'physical-camera', observedCommit: acceptance.observedBuild.commit,
        observedBuildId: acceptance.observedBuild.buildId, frameCount: acceptance.evidence.length,
        stepCount: acceptance.steps.length, evidenceSha256: evidenceDigest(acceptance.evidence), reportSha256 },
    };
    validateDeviceReceipt(receipt, { task: context.task, runId: context.state.runId, deployKey, now: completedAt });
    await saveReport(directory, 'receipt', receipt);
    Object.freeze(receipt.acceptance);
    Object.freeze(receipt);
    privateReceipts.add(receipt);
    return receipt;
  });
}
