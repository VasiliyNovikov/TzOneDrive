import { createHash, randomInt, randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { AdapterError, boundedInteger, exactKeys } from './adapters/process.mjs';

export const ACTION_KEYS = Object.freeze([
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'PLAY_PAUSE',
  ...Array.from({ length: 10 }, (_, index) => `DIGIT_${index}`),
]);

export const VISUAL_CRITERIA = Object.freeze([
  'beforeState', 'afterState', 'remoteResponse', 'readable', 'unobstructed', 'noError',
]);

// These assertions are code-owned, not supplied by a model or a report under test.
export const ACCEPTANCE_STEPS = Object.freeze([
  { id: 'browse-folders', key: 'BACK', before: 'Diagnostics screen with full build identity', after: 'Fixture folders screen with first folder focused', waitMs: 500 },
  { id: 'open-folder', key: 'ENTER', before: 'Fixture folders screen with first folder focused', after: 'First fixture folder with photo thumbnails and first photo focused', waitMs: 500 },
  { id: 'open-photo', key: 'ENTER', before: 'First fixture folder with first photo focused', after: 'First fixture photo displayed full screen, paused', waitMs: 500 },
  { id: 'next-photo', key: 'RIGHT', before: 'First fixture photo displayed full screen, paused', after: 'Second fixture photo displayed full screen, paused', waitMs: 500 },
  { id: 'previous-photo', key: 'LEFT', before: 'Second fixture photo displayed full screen, paused', after: 'First fixture photo displayed full screen, paused', waitMs: 500 },
  { id: 'start-slideshow', key: 'PLAY_PAUSE', before: 'First fixture photo displayed full screen, paused', after: 'Slideshow playing and photo advanced without another navigation key', waitMs: 5500 },
  { id: 'pause-slideshow', key: 'PLAY_PAUSE', before: 'Slideshow playing', after: 'Slideshow paused on the same photo even after a full slideshow interval', waitMs: 5500 },
  { id: 'back-to-folder', key: 'BACK', before: 'Full screen photo, paused', after: 'First fixture folder thumbnails with visible focus', waitMs: 500 },
  { id: 'back-to-folders', key: 'BACK', before: 'First fixture folder thumbnails with visible focus', after: 'Fixture folders screen with visible focus', waitMs: 500 },
]);

const REPORT_CHECKS = [
  'connected', 'buildIdentity', 'freshFrames', 'readable', 'unobstructed', 'visualAssertions',
];

export function validateExpectedBuild(value) {
  if (!exactKeys(value, ['commit', 'buildId'])
      || !/^[a-f0-9]{40}$/u.test(value.commit)
      || typeof value.buildId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.buildId)) {
    throw new AdapterError('INVALID_CONFIG', 'expectedBuild requires an exact full lowercase commit and buildId');
  }
  return { commit: value.commit, buildId: value.buildId };
}

export function validateVisualVerdict(value) {
  if (!exactKeys(value, ['verdict', 'criteria', 'reason'])
      || !['PASS', 'FAIL', 'INCONCLUSIVE'].includes(value.verdict)
      || !exactKeys(value.criteria, VISUAL_CRITERIA)
      || VISUAL_CRITERIA.some((key) => ![true, false, null].includes(value.criteria[key]))
      || typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 2000) {
    throw new AdapterError('INVALID_VERDICT', 'Visual response does not match the exact JSON verdict contract');
  }
  const values = Object.values(value.criteria);
  const inferred = value.criteria.readable !== true || value.criteria.unobstructed !== true || values.includes(null)
    ? 'INCONCLUSIVE' : values.every((entry) => entry === true) ? 'PASS' : 'FAIL';
  if (inferred !== value.verdict) {
    throw new AdapterError('INVALID_VERDICT', 'Visual verdict disagrees with its fixed criteria');
  }
  return value;
}

export function validateBuildObservation(value) {
  if (!exactKeys(value, ['schemaVersion', 'requestId', 'frameSha256', 'challenge', 'commit', 'buildId', 'readable', 'unobstructed'])
      || value.schemaVersion !== 1
      || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/u.test(value.requestId)
      || typeof value.frameSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.frameSha256)
      || ![true, false].includes(value.readable) || ![true, false].includes(value.unobstructed)
      || ![value.challenge, value.commit, value.buildId].every((entry) => entry === null || typeof entry === 'string')
      || (typeof value.challenge === 'string' && value.challenge.length > 64)
      || (typeof value.commit === 'string' && value.commit.length > 128)
      || (typeof value.buildId === 'string' && value.buildId.length > 128)) {
    throw new AdapterError('INVALID_DETECTION', 'Camera decoder response does not match the exact JSON contract');
  }
  return value;
}

export async function inspectFrame(frame, { issuedAt, issuedMonotonicNs, previousMonotonicNs, seenHashes, maxBytes, maxAgeMs }) {
  if (!frame || typeof frame.path !== 'string' || typeof frame.capturedAt !== 'string'
      || typeof frame.monotonicNs !== 'string' || !/^\d{1,30}$/u.test(frame.monotonicNs)
      || typeof frame.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(frame.sha256)) {
    throw new AdapterError('INVALID_FRAME', 'Camera did not provide complete frame metadata');
  }
  const capturedAt = Date.parse(frame.capturedAt);
  const now = Date.now();
  const monotonicNs = BigInt(frame.monotonicNs);
  if (!Number.isFinite(capturedAt) || capturedAt < issuedAt || capturedAt > now
      || now - capturedAt > maxAgeMs || monotonicNs < issuedMonotonicNs
      || monotonicNs > process.hrtime.bigint()
      || (previousMonotonicNs !== null && monotonicNs <= previousMonotonicNs)) {
    throw new AdapterError('STALE_FRAME', 'Frame timestamp is stale or not strictly monotonic');
  }
  const stat = await lstat(frame.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > maxBytes
      || stat.mtimeMs < issuedAt - 1) {
    throw new AdapterError('INVALID_FRAME', 'Frame is missing, stale, not a regular file, or outside size limits');
  }
  const handle = await open(frame.path, 'r');
  let buffer;
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.ino !== stat.ino || openedStat.size !== stat.size) {
      throw new AdapterError('INVALID_FRAME', 'Frame changed during inspection');
    }
    buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new AdapterError('INVALID_FRAME', 'Frame changed during read');
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && buffer.subarray(-8).equals(Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  if (!png && !jpeg) throw new AdapterError('INVALID_FRAME', 'Frame is not a complete JPEG or PNG image');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== frame.sha256) throw new AdapterError('FRAME_HASH_MISMATCH', 'Frame bytes do not match the capture hash');
  if (seenHashes.has(sha256)) throw new AdapterError('REUSED_FRAME', 'A prior camera frame was reused');
  seenHashes.add(sha256);
  return { sha256, bytes: buffer.length, format: png ? 'png' : 'jpeg', monotonicNs: frame.monotonicNs, capturedAt: frame.capturedAt };
}

export function acceptanceLimits(config) {
  const supplied = config.timeouts ?? {};
  return {
    operationMs: boundedInteger(supplied.operationMs, 15_000, 1, 120_000, 'operationMs'),
    inferenceMs: boundedInteger(supplied.inferenceMs, 60_000, 1, 120_000, 'inferenceMs'),
    totalMs: boundedInteger(supplied.totalMs, 240_000, 1, 600_000, 'totalMs'),
    settleMs: boundedInteger(supplied.settleMs, 300, 0, 5000, 'settleMs'),
    maxFrameAgeMs: boundedInteger(config.camera?.maxFrameAgeMs, 10_000, 1, 30_000, 'maxFrameAgeMs'),
    maxFrameBytes: boundedInteger(config.camera?.maxFrameBytes, 8 * 1024 * 1024, 64, 20 * 1024 * 1024, 'maxFrameBytes'),
  };
}

export async function runAcceptance({ config, adapters, expectedBuild = config.expectedBuild }) {
  const report = {
    schemaVersion: 1, operation: 'accept', mode: config.mode,
    status: 'INCONCLUSIVE', reasonCode: 'NOT_RUN', reason: 'Acceptance has not completed',
    expectedBuild: null, observedBuild: null, gateEligible: false,
    publicArtifactsAllowed: config.mode === 'mock',
    startedAt: new Date().toISOString(), completedAt: null,
    checks: Object.fromEntries(REPORT_CHECKS.map((key) => [key, 'INCONCLUSIVE'])),
    steps: [], evidence: [],
  };
  const controller = new AbortController();
  let totalTimer;
  try {
    report.expectedBuild = validateExpectedBuild(expectedBuild);
    if (!['real', 'mock'].includes(config.mode) || adapters.mode !== config.mode
        || (config.mode === 'real' && adapters.synthetic !== false)) {
      throw new AdapterError('MODE_MISMATCH', 'Synthetic or mismatched adapters cannot satisfy real acceptance');
    }
    if (config.mode === 'real') {
      const { isRealAdapter } = await import('./adapters/real.mjs');
      if (!isRealAdapter(adapters)) throw new AdapterError('MODE_MISMATCH', 'Only concrete production adapters can satisfy the real device gate');
    }
    const limits = acceptanceLimits(config);
    const deadline = performance.now() + limits.totalMs;
    totalTimer = setTimeout(() => controller.abort(), limits.totalMs);
    const bounded = async (operation, timeoutMs = limits.operationMs) => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0 || controller.signal.aborted) throw new AdapterError('TIMEOUT', 'Acceptance deadline exceeded');
      let timer;
      const localController = new AbortController();
      const abort = () => localController.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        return await Promise.race([
          Promise.resolve().then(() => operation(localController.signal)),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              localController.abort();
              reject(new AdapterError('TIMEOUT', 'Acceptance operation exceeded its deadline'));
            }, Math.min(timeoutMs, remaining));
          }),
        ]);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
      }
    };
    const wait = async (duration) => {
      if (config.mode === 'mock') return;
      await bounded((signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, duration);
        const abort = () => {
          clearTimeout(timer);
          reject(new AdapterError('TIMEOUT', 'Wait cancelled'));
        };
        signal.addEventListener('abort', abort, { once: true });
      }), duration + 1000);
    };
    const connected = await bounded((signal) => adapters.checkConnection({ signal }));
    if (connected !== true) throw new AdapterError('DISCONNECTED', 'The configured device is not connected');
    report.checks.connected = 'PASS';
    if (typeof adapters.visualReady !== 'function'
        || await bounded((signal) => adapters.visualReady({ signal })) !== true) {
      throw new AdapterError('INFERENCE_UNAVAILABLE', 'Explicitly approved visual model is unavailable');
    }
    const seenHashes = new Set();
    const seenChallenges = new Set();
    let previousMonotonicNs = null;
    let actionCount = 0;
    const remote = async (key) => {
      if (!ACTION_KEYS.includes(key) || ++actionCount > 160) {
        throw new AdapterError('ACTION_LIMIT', 'Remote action is not allowlisted or action budget exceeded');
      }
      await bounded((signal) => adapters.remote({ key, signal }));
    };
    const capture = async (stepId, position) => {
      let challenge;
      do { challenge = String(randomInt(0, 1_000_000)).padStart(6, '0'); } while (seenChallenges.has(challenge));
      seenChallenges.add(challenge);
      for (const digit of challenge) await remote(`DIGIT_${digit}`);
      await wait(limits.settleMs);
      const issuedAt = Date.now();
      const issuedMonotonicNs = process.hrtime.bigint();
      const requestId = randomUUID();
      const frame = await bounded((signal) => adapters.capture({ requestId, signal }));
      const metadata = await inspectFrame(frame, {
        issuedAt, issuedMonotonicNs, previousMonotonicNs, seenHashes,
        maxBytes: limits.maxFrameBytes, maxAgeMs: limits.maxFrameAgeMs,
      });
      previousMonotonicNs = BigInt(metadata.monotonicNs);
      // Expected build and challenge are deliberately NOT given to the decoder.
      const observed = validateBuildObservation(await bounded((signal) => adapters.detectBuild({
        requestId, framePath: frame.path, frameSha256: metadata.sha256, signal,
      }), limits.inferenceMs));
      if (observed.requestId !== requestId || observed.frameSha256 !== metadata.sha256) {
        throw new AdapterError('DETECTION_MISMATCH', 'Camera decoder response is not bound to this frame');
      }
      if (!observed.readable) throw new AdapterError('UNREADABLE', 'Build identity cannot be read from the camera image');
      if (!observed.unobstructed) throw new AdapterError('OBSTRUCTED', 'Camera view is obstructed');
      if (observed.challenge !== challenge) throw new AdapterError('STALE_FRAME', 'Camera-visible fresh challenge was not observed');
      report.observedBuild = { commit: observed.commit, buildId: observed.buildId };
      if (observed.commit !== report.expectedBuild.commit || observed.buildId !== report.expectedBuild.buildId) {
        throw new AdapterError('BUILD_MISMATCH', 'Camera independently observed a different commit or package build');
      }
      report.evidence.push({
        id: `${stepId}-${position}`, ...metadata, challenge, synthetic: config.mode === 'mock',
      });
      return { ...frame, ...metadata, challenge };
    };
    for (const step of ACCEPTANCE_STEPS) {
      const before = await capture(step.id, 'before');
      await remote(step.key);
      await wait(step.waitMs);
      const after = await capture(step.id, 'after');
      const verdict = validateVisualVerdict(await bounded((signal) => adapters.evaluate({
        step, before, after, expectedBuild: report.expectedBuild, signal,
      }), limits.inferenceMs));
      report.steps.push({ id: step.id, ...verdict });
      if (verdict.verdict !== 'PASS') {
        report.status = verdict.verdict;
        report.reasonCode = verdict.verdict === 'FAIL' ? 'VISUAL_ASSERTION_FAILED' : 'VISUAL_INCONCLUSIVE';
        report.reason = verdict.reason;
        report.checks.visualAssertions = verdict.verdict;
        report.checks.readable = verdict.criteria.readable === true ? 'PASS' : 'INCONCLUSIVE';
        report.checks.unobstructed = verdict.criteria.unobstructed === true ? 'PASS' : 'INCONCLUSIVE';
        return report;
      }
    }
    if (report.steps.length !== ACCEPTANCE_STEPS.length || report.evidence.length !== ACCEPTANCE_STEPS.length * 2) {
      throw new AdapterError('INCOMPLETE', 'Not all fixed acceptance criteria were evaluated');
    }
    report.checks = Object.fromEntries(REPORT_CHECKS.map((key) => [key, 'PASS']));
    report.status = 'PASS';
    report.reasonCode = 'ACCEPTED';
    report.reason = config.mode === 'mock' ? 'Synthetic acceptance passed; not a physical-device gate' : 'All fixed physical camera acceptance criteria passed';
    report.gateEligible = config.mode === 'real';
    return report;
  } catch (error) {
    report.status = error.code === 'BUILD_MISMATCH' ? 'FAIL' : 'INCONCLUSIVE';
    report.reasonCode = typeof error.code === 'string' ? error.code : 'UNAVAILABLE';
    report.reason = error instanceof AdapterError ? error.message : 'A required local adapter or evidence file was unavailable';
    return report;
  } finally {
    clearTimeout(totalTimer);
    controller.abort();
    report.completedAt = new Date().toISOString();
  }
}
