import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ACCEPTANCE_STEPS, VISUAL_CRITERIA, runAcceptance, validateExpectedBuild, validateVisualVerdict } from '../factory/acceptance.mjs';
import { runDevice } from '../factory/device.mjs';
import { createMockAdapters } from '../factory/adapters/mock.mjs';

const expectedBuild = { commit: 'a'.repeat(40), buildId: 'fixture-package' };

async function fixture(t, scenario = 'pass') {
  const outputDir = resolve('.factory-local', `acceptance-test-${randomUUID()}`);
  await mkdir(outputDir, { recursive: true });
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  return { mode: 'mock', expectedBuild: { ...expectedBuild }, camera: { outputDir }, mock: { scenario } };
}

test('mock acceptance evaluates every fixed transition with fresh, correlated synthetic frames', async (t) => {
  const config = await fixture(t);
  const adapters = createMockAdapters(config);
  const detectBuild = adapters.detectBuild;
  adapters.detectBuild = t.mock.fn(async (request) => {
    assert.deepEqual(Object.keys(request).sort(), ['framePath', 'frameSha256', 'requestId', 'signal']);
    return detectBuild(request);
  });
  const report = await runDevice({ operation: 'accept', config, dependencies: { adapters } });
  assert.equal(report.status, 'PASS');
  assert.equal(report.reasonCode, 'ACCEPTED');
  assert.deepEqual(report.expectedBuild, expectedBuild);
  assert.deepEqual(report.observedBuild, expectedBuild);
  assert.equal(report.gateEligible, false);
  assert.equal(report.publicArtifactsAllowed, true);
  assert.match(report.reason, /Synthetic acceptance/);
  assert.ok(Object.values(report.checks).every((value) => value === 'PASS'));
  assert.deepEqual(report.steps.map((step) => step.id), ACCEPTANCE_STEPS.map((step) => step.id));
  for (const step of report.steps) {
    assert.equal(step.verdict, 'PASS');
    assert.deepEqual(step.criteria, Object.fromEntries(VISUAL_CRITERIA.map((key) => [key, true])));
  }
  assert.deepEqual(report.evidence.map((frame) => frame.id),
    ACCEPTANCE_STEPS.flatMap((step) => [`${step.id}-before`, `${step.id}-after`]));
  assert.equal(adapters.detectBuild.mock.callCount(), 18);
  assert.equal(new Set(report.evidence.map((frame) => frame.sha256)).size, 18);
  assert.equal(new Set(report.evidence.map((frame) => frame.challenge)).size, 18);
  for (const [index, frame] of report.evidence.entries()) {
    assert.equal(frame.synthetic, true);
    assert.equal(frame.format, 'png');
    assert.ok(frame.bytes >= 16);
    assert.match(frame.sha256, /^[a-f0-9]{64}$/u);
    assert.match(frame.challenge, /^\d{6}$/u);
    if (index) assert.ok(BigInt(frame.monotonicNs) > BigInt(report.evidence[index - 1].monotonicNs));
  }
  assert.ok(Date.parse(report.completedAt) >= Date.parse(report.startedAt));
});

test('bad navigation fails the next-photo visual assertion and stops acceptance', async (t) => {
  const config = await fixture(t, 'navigation-failure');
  const report = await runDevice({ operation: 'accept', config });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.reasonCode, 'VISUAL_ASSERTION_FAILED');
  assert.deepEqual(report.steps.map((step) => [step.id, step.verdict]), [
    ['browse-folders', 'PASS'], ['open-folder', 'PASS'], ['open-photo', 'PASS'], ['next-photo', 'FAIL'],
  ]);
  assert.equal(report.steps.at(-1).criteria.beforeState, true);
  assert.equal(report.steps.at(-1).criteria.afterState, false);
  assert.equal(report.steps.at(-1).criteria.remoteResponse, false);
  assert.equal(report.checks.visualAssertions, 'FAIL');
  assert.equal(report.evidence.length, 8);
  assert.equal(report.gateEligible, false);
});

test('unavailable, obstructed, stale or invalid camera evidence remains inconclusive', async (t) => {
  for (const [scenario, reasonCode, evidenceCount] of [
    ['missing-camera', 'CAMERA_UNAVAILABLE', 0],
    ['obstructed', 'OBSTRUCTED', 0],
    ['unreadable', 'UNREADABLE', 0],
    ['stale-frame', 'STALE_FRAME', 0],
    ['reused-frame', 'REUSED_FRAME', 1],
    ['hash-mismatch', 'FRAME_HASH_MISMATCH', 0],
    ['invalid-verdict', 'INVALID_VERDICT', 2],
    ['disconnected', 'DISCONNECTED', 0],
    ['inference-unavailable', 'INFERENCE_UNAVAILABLE', 0],
  ]) await t.test(scenario, async (t) => {
    const config = await fixture(t, scenario);
    const report = await runDevice({ operation: 'accept', config });
    assert.equal(report.status, 'INCONCLUSIVE');
    assert.equal(report.reasonCode, reasonCode);
    assert.equal(report.evidence.length, evidenceCount);
    assert.deepEqual(report.steps, []);
    assert.equal(report.gateEligible, false);
    assert.ok(report.completedAt);
  });
});

test('camera observations must match both independently requested build identifiers', async (t) => {
  for (const mismatch of [{ commit: 'b'.repeat(40) }, { buildId: 'different-package' }]) {
    await t.test(Object.keys(mismatch)[0], async (t) => {
      const config = await fixture(t);
      const adapters = createMockAdapters(config);
      const requested = { ...expectedBuild, ...mismatch };
      const report = await runDevice({
        operation: 'accept', config, expectedBuild: requested, dependencies: { adapters },
      });
      assert.equal(report.status, 'FAIL');
      assert.equal(report.reasonCode, 'BUILD_MISMATCH');
      assert.deepEqual(report.expectedBuild, requested);
      assert.deepEqual(report.observedBuild, expectedBuild);
      assert.deepEqual(report.evidence, []);
      assert.equal(report.gateEligible, false);
    });
  }
});

test('decoder replies must match the exact request, frame hash and fresh challenge', async (t) => {
  for (const [field, value, reasonCode] of [
    ['requestId', 'unrelated-request', 'DETECTION_MISMATCH'],
    ['frameSha256', '0'.repeat(64), 'DETECTION_MISMATCH'],
    ['challenge', 'not-the-six-digit-challenge', 'STALE_FRAME'],
  ]) await t.test(field, async (t) => {
    const config = await fixture(t);
    const adapters = createMockAdapters(config);
    const detectBuild = adapters.detectBuild;
    adapters.detectBuild = async (request) => ({ ...await detectBuild(request), [field]: value });
    const report = await runAcceptance({ config, adapters });
    assert.equal(report.status, 'INCONCLUSIVE');
    assert.equal(report.reasonCode, reasonCode);
    assert.deepEqual(report.evidence, []);
    assert.equal(report.gateEligible, false);
  });
});

test('acceptance bounds a non-responsive remote and the total operation deadline', { timeout: 5000 }, async (t) => {
  await t.test('remote timeout', async (t) => {
    const config = await fixture(t, 'timeout');
    config.timeouts = { operationMs: 25, totalMs: 1000 };
    const report = await runDevice({ operation: 'accept', config });
    assert.equal(report.status, 'INCONCLUSIVE');
    assert.equal(report.reasonCode, 'TIMEOUT');
    assert.equal(report.gateEligible, false);
    assert.deepEqual(report.evidence, []);
  });
  await t.test('total deadline', async (t) => {
    const config = await fixture(t);
    config.timeouts = { operationMs: 1000, totalMs: 25 };
    const adapters = createMockAdapters(config);
    let signal;
    adapters.checkConnection = (options) => {
      signal = options.signal;
      return new Promise(() => {});
    };
    const report = await runAcceptance({ config, adapters });
    assert.equal(report.status, 'INCONCLUSIVE');
    assert.equal(report.reasonCode, 'TIMEOUT');
    assert.equal(report.gateEligible, false);
    assert.equal(signal.aborted, true);
  });
});

test('mock and relabelled adapters cannot satisfy a real acceptance gate', async (t) => {
  for (const relabel of [false, true]) await t.test(relabel ? 'relabelled' : 'mock', async (t) => {
    const config = await fixture(t);
    const adapters = createMockAdapters(config);
    if (relabel) Object.assign(adapters, { mode: 'real', synthetic: false });
    adapters.checkConnection = t.mock.fn();
    const report = await runDevice({ operation: 'accept', config: { ...config, mode: 'real' }, dependencies: { adapters } });
    assert.equal(report.status, 'INCONCLUSIVE');
    assert.equal(report.reasonCode, 'MODE_MISMATCH');
    assert.equal(report.gateEligible, false);
    assert.equal(report.publicArtifactsAllowed, false);
    assert.equal(adapters.checkConnection.mock.callCount(), 0);
  });
});

test('visual verdicts require exact criteria and fail closed on unknown or unreadable evidence', () => {
  const criteria = Object.fromEntries(VISUAL_CRITERIA.map((key) => [key, true]));
  const pass = { verdict: 'PASS', criteria, reason: 'Fixture visual criteria' };
  assert.deepEqual(validateVisualVerdict(pass), pass);
  for (const [key, value, verdict] of [
    ['afterState', false, 'FAIL'], ['remoteResponse', null, 'INCONCLUSIVE'],
    ['readable', false, 'INCONCLUSIVE'], ['unobstructed', false, 'INCONCLUSIVE'],
  ]) {
    const result = { ...pass, verdict, criteria: { ...criteria, [key]: value } };
    assert.deepEqual(validateVisualVerdict(result), result);
    assert.throws(() => validateVisualVerdict({ ...result, verdict: 'PASS' }), { code: 'INVALID_VERDICT' });
  }
  for (const invalid of [
    { ...pass, extra: true }, { ...pass, criteria: { ...criteria, extra: true } },
    { ...pass, criteria: {} }, { ...pass, reason: '' },
  ]) assert.throws(() => validateVisualVerdict(invalid), { code: 'INVALID_VERDICT' });
});

test('expected build identity rejects shortened, uppercase, incomplete or extra fields', () => {
  assert.deepEqual(validateExpectedBuild(expectedBuild), expectedBuild);
  for (const invalid of [
    null, { commit: 'a'.repeat(7), buildId: 'fixture' },
    { ...expectedBuild, commit: 'A'.repeat(40) }, { commit: expectedBuild.commit },
    { ...expectedBuild, buildId: '../package' }, { ...expectedBuild, extra: true },
  ]) assert.throws(() => validateExpectedBuild(invalid), { code: 'INVALID_CONFIG' });
});
