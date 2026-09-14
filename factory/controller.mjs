import { createHash } from 'node:crypto';
import { isPrivateDeviceReceipt, validateDeviceReceipt, validateTestedManifest } from './device-bridge.mjs';
import {
  BudgetError, INFERENCE_ACTIONS, assertBudgetLedger, createBudgetLedger,
  reserveInferenceBudget, settleInferenceBudget
} from './budget.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  experimentMs: 24 * 60 * 60 * 1000,
  maxActions: 100,
  maxStageAttempts: 4,
  maxRetries: 3,
  maxRepairs: 2,
  maxFollowUps: 1,
  maxInconclusive: 2,
  maxPolls: 30,
  noProgressMs: 30 * 60 * 1000,
  baseBackoffMs: 1000,
  maxBackoffMs: 60 * 1000,
});

const ACTIONS = ['plan', 'implement', 'pr', 'validate', 'repair', 'merge', 'deploy', 'accept'];
const TERMINAL = new Set(['delivered', 'blocked']);
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => structuredClone(value);

function time(value) {
  const result = typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('now must be an epoch timestamp or ISO date');
  return result;
}

function validateLimits(limits) {
  if (!limits || Object.keys(limits).length !== Object.keys(DEFAULT_LIMITS).length) throw new Error('Invalid limits');
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_LIMITS) || !Number.isSafeInteger(value) || value < 0 ||
        (['experimentMs', 'maxActions', 'maxStageAttempts', 'noProgressMs', 'baseBackoffMs', 'maxBackoffMs'].includes(key) && !value)) {
      throw new Error(`Invalid limit: ${key}`);
    }
  }
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function taskRecord(input, now) {
  if (!input || !ID.test(input.id)) throw new Error('Task IDs must match [a-z][a-z0-9-]{0,63}');
  if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 16000) {
    throw new Error('Each task needs a nonempty trusted goal (at most 16000 characters)');
  }
  if (input.dependsOn !== undefined && !Array.isArray(input.dependsOn)) throw new Error('dependsOn must be an array');
  return {
    id: input.id,
    goal: input.goal,
    goalHash: digest(input.goal),
    dependsOn: [...new Set(input.dependsOn ?? [])],
    status: 'queued',
    stage: 'plan',
    attempts: {},
    retries: {},
    inconclusive: {},
    repairCount: 0,
    followUpDepth: 0,
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    nextActionAt: null,
    intent: null,
    evidence: {},
    history: [],
  };
}

export function createState(tasks, { mode = 'mock', now = Date.now(), limits = {}, runId } = {}) {
  now = time(now);
  if (!['mock', 'real'].includes(mode)) throw new Error('mode must be mock or real');
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('A trusted nonempty backlog is required');
  const resolvedLimits = { ...DEFAULT_LIMITS, ...limits };
  validateLimits(resolvedLimits);
  const state = {
    version: 1,
    mode,
    originMode: mode,
    runId: runId ?? digest(JSON.stringify({ tasks, mode, now })).slice(0, 24),
    simulated: mode === 'mock',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + resolvedLimits.experimentMs,
    limits: resolvedLimits,
    actionCount: 0,
    budget: createBudgetLedger(),
    activeTaskId: null,
    nextWakeAt: null,
    tasks: tasks.map((input) => taskRecord(input, now)),
  };
  assertState(state);
  return state;
}

export function assertState(state) {
  if (state?.version !== 1 || !['mock', 'real'].includes(state.mode) ||
      state.mode !== state.originMode || state.simulated !== (state.mode === 'mock')) {
    throw new Error('Invalid state version or immutable execution mode');
  }
  if (typeof state.runId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(state.runId)) throw new Error('Invalid runId');
  validateLimits(state.limits);
  if (!Number.isSafeInteger(state.actionCount) || state.actionCount < 0 ||
      !Number.isSafeInteger(state.createdAt) || !Number.isSafeInteger(state.updatedAt) ||
      !Number.isSafeInteger(state.expiresAt) || state.expiresAt !== state.createdAt + state.limits.experimentMs ||
      state.updatedAt < state.createdAt ||
      !['running', 'waiting', 'stopped', 'delivered', 'blocked'].includes(state.status)) {
    throw new Error('Invalid durable counters, deadline, or state status');
  }
  if (!Array.isArray(state.tasks) || !state.tasks.length) throw new Error('Invalid backlog');
  assertBudgetLedger(state.budget);
  const byId = new Map();
  for (const task of state.tasks) {
    if (!ID.test(task.id) || byId.has(task.id) || typeof task.goal !== 'string' || digest(task.goal) !== task.goalHash ||
        !Array.isArray(task.dependsOn) || !ACTIONS.includes(task.stage) ||
        !['queued', 'running', 'waiting', 'repair', 'delivered', 'blocked'].includes(task.status)) {
      throw new Error('Invalid task or mutated trusted goal');
    }
    for (const counters of [task.attempts, task.retries, task.inconclusive]) {
      if (!counters || Object.entries(counters).some(([key, value]) =>
        !ACTIONS.includes(key) || !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid task counters');
    }
    if (!Number.isSafeInteger(task.repairCount) || task.repairCount < 0 ||
        !Number.isSafeInteger(task.followUpDepth) || task.followUpDepth < 0 ||
        !Number.isSafeInteger(task.lastProgressAt) || !task.evidence || !Array.isArray(task.history) ||
        (task.status === 'waiting' && !Number.isSafeInteger(task.nextActionAt))) throw new Error('Invalid task bookkeeping');
    byId.set(task.id, task);
  }
  const visited = new Set();
  function visit(id, visiting = new Set()) {
    if (visiting.has(id)) throw new Error('Dependency cycle');
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown dependency: ${id}`);
    for (const dependency of task.dependsOn) visit(dependency, new Set([...visiting, id]));
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  const active = state.tasks.filter((task) => ['running', 'waiting'].includes(task.status));
  if (active.length > 1 || (active[0] && active[0].id !== state.activeTaskId) ||
      (state.activeTaskId && !byId.has(state.activeTaskId))) throw new Error('Invalid single-active-task invariant');
  return state;
}

function summarize(state) {
  state.nextWakeAt = null;
  if (state.status === 'stopped') return;
  const unfinished = state.tasks.filter((task) => !TERMINAL.has(task.status));
  if (!unfinished.length) {
    state.status = state.tasks.some((task) => task.status === 'blocked') ? 'blocked' : 'delivered';
    state.activeTaskId = null;
  } else {
    const active = state.tasks.find((task) => task.id === state.activeTaskId);
    state.status = active?.status === 'waiting' ? 'waiting' : 'running';
    if (active?.status === 'waiting') {
      state.nextWakeAt = Math.min(active.nextActionAt, state.expiresAt, active.lastProgressAt + state.limits.noProgressMs);
    }
  }
}

function block(task, code, now) {
  task.status = 'blocked';
  task.blockedReason = code;
  task.updatedAt = now;
  task.nextActionAt = null;
  // Keep unresolved intent as evidence: a crash may have completed the remote operation.
  task.history.push({ type: 'blocked', code, at: now });
}

function settle(state, now) {
  let changed;
  do {
    changed = false;
    for (const task of state.tasks) {
      if (TERMINAL.has(task.status)) continue;
      if (task.status === 'repair') {
        const followUp = state.tasks.find((item) => item.id === task.followUpTaskId);
        if (TERMINAL.has(followUp?.status)) {
          task.status = followUp.status;
          task.updatedAt = now;
          task.evidence.followUp = { taskId: followUp.id, status: followUp.status, simulated: state.simulated };
          if (followUp.status === 'blocked') task.blockedReason = 'follow-up-blocked';
          else task.delivery = followUp.delivery;
          changed = true;
        }
      } else if (task.dependsOn.some((id) => state.tasks.find((item) => item.id === id)?.status === 'blocked')) {
        block(task, 'dependency-blocked', now);
        changed = true;
      }
    }
  } while (changed);
  if (TERMINAL.has(state.tasks.find((task) => task.id === state.activeTaskId)?.status)) state.activeTaskId = null;
  summarize(state);
}

function transition(task, stage, now) {
  task.stage = stage;
  task.status = 'running';
  task.updatedAt = now;
  task.lastProgressAt = now;
  task.nextActionAt = null;
}

function wait(task, now, count, limits, requestedAt) {
  const delay = Math.min(limits.maxBackoffMs, limits.baseBackoffMs * 2 ** Math.min(count - 1, 30));
  task.status = 'waiting';
  task.nextActionAt = Math.max(now + delay, requestedAt ?? 0);
  task.updatedAt = now;
}

export function validationGate(task, mode = 'mock') {
  const evidence = task.evidence.validate;
  const headSha = task.evidence.pr?.headSha;
  if (!SHA.test(headSha ?? '') || task.evidence.implement?.headSha !== headSha ||
      evidence?.verdict !== 'PASS' || evidence.headSha !== headSha || evidence.testedSha !== headSha) {
    return 'validation-head-tested-sha-mismatch';
  }
  if (evidence.ciPassed !== true || evidence.independentReview?.verdict !== 'PASS' ||
      evidence.independentReview.independent !== true || !evidence.independentReview.reviewer) {
    return 'independent-review-or-ci-not-passed';
  }
  const artifact = evidence.package;
  if (!artifact?.buildId || !HASH.test(artifact.sha256 ?? '') || artifact.headSha !== headSha) {
    return 'uncorrelated-tested-package';
  }
  if (mode === 'real') {
    try { validateTestedManifest(artifact, headSha); }
    catch { return 'uncorrelated-tested-unsigned-manifest'; }
  }
  return null;
}

function deploymentGate(task, receipt, mode) {
  const artifact = task.evidence.validate?.package;
  if (!artifact || receipt.headSha !== artifact.headSha || receipt.buildId !== artifact.buildId ||
      receipt.packageSha256 !== artifact.sha256) return 'deployment-package-mismatch';
  if (receipt.deviceMode !== (mode === 'real' ? 'real' : 'mock') || !receipt.deviceId ||
      receipt.installed !== true || receipt.launched !== true) return 'physical-deployment-required';
  return null;
}

function acceptanceGate(task, receipt, mode) {
  const deployment = task.evidence.deploy;
  if (!deployment || receipt.headSha !== deployment.headSha || receipt.buildId !== deployment.buildId ||
      receipt.packageSha256 !== deployment.packageSha256 || receipt.deviceId !== deployment.deviceId ||
      receipt.deviceMode !== deployment.deviceMode) return 'acceptance-deployment-mismatch';
  if (receipt.navigation?.verdict !== 'PASS' || receipt.camera?.verdict !== 'PASS' ||
      !receipt.camera.artifact || (mode === 'real' && receipt.camera.source !== 'physical-camera')) {
    return 'physical-camera-and-navigation-required';
  }
  return null;
}

function repairFollowUp(state, task, now) {
  if (task.followUpDepth >= state.limits.maxFollowUps) {
    block(task, 'physical-repair-limit', now);
    return;
  }
  const id = `${task.id.slice(0, 44)}-repair-${digest(`${task.id}:${task.followUpDepth + 1}`).slice(0, 10)}`;
  const followUp = taskRecord({
    id,
    goal: task.goal,
    dependsOn: task.dependsOn,
  }, now);
  followUp.sourceTaskId = task.id;
  followUp.followUpDepth = task.followUpDepth + 1;
  followUp.evidence.repairRequest = {
    sourceTaskId: task.id,
    reason: 'physical-acceptance-failed',
    acceptance: clone(task.evidence.accept),
    mergedPr: clone(task.evidence.pr),
  };
  state.tasks.push(followUp);
  task.followUpTaskId = id;
  task.status = 'repair';
  task.updatedAt = now;
  state.activeTaskId = null;
}

function applyReceipt(state, task, action, receipt, now) {
  if (receipt.verdict === 'INCONCLUSIVE') {
    task.inconclusive[action] = (task.inconclusive[action] ?? 0) + 1;
    if (task.inconclusive[action] > state.limits.maxInconclusive) block(task, 'inconclusive-limit', now);
    else wait(task, now, task.inconclusive[action], state.limits);
    return;
  }
  if (receipt.verdict === 'FAIL') {
    if (action === 'accept') repairFollowUp(state, task, now);
    else if (action === 'validate') {
      if (task.repairCount >= state.limits.maxRepairs) block(task, 'repair-limit', now);
      else transition(task, 'repair', now);
    } else if (['plan', 'implement', 'pr', 'repair'].includes(action)) {
      wait(task, now, task.attempts[action], state.limits);
    } else block(task, `${action}-failed`, now);
    return;
  }
  let problem;
  switch (action) {
    case 'plan':
      if (typeof receipt.plan !== 'string' || !receipt.plan.trim()) problem = 'missing-plan';
      else transition(task, 'implement', now);
      break;
    case 'implement':
      if (!SHA.test(receipt.headSha ?? '')) problem = 'invalid-implementation-sha';
      else transition(task, 'pr', now);
      break;
    case 'pr':
      if (!Number.isSafeInteger(receipt.prNumber) || receipt.prNumber <= 0 ||
          receipt.headSha !== task.evidence.implement.headSha) problem = 'pr-head-mismatch';
      else transition(task, 'validate', now);
      break;
    case 'validate':
      problem = validationGate(task, state.mode);
      if (!problem) transition(task, 'merge', now);
      break;
    case 'repair':
      if (!SHA.test(receipt.headSha ?? '') || receipt.headSha === task.evidence.implement.headSha ||
          receipt.prNumber !== task.evidence.pr.prNumber) problem = 'repair-did-not-update-unmerged-pr';
      else {
        task.evidence.implement = clone(receipt);
        task.evidence.pr.headSha = receipt.headSha;
        delete task.evidence.validate;
        transition(task, 'validate', now);
      }
      break;
    case 'merge':
      problem = validationGate(task, state.mode);
      if (!problem && (receipt.merged !== true || receipt.headSha !== task.evidence.validate.testedSha ||
          !SHA.test(receipt.mergeSha ?? ''))) problem = 'merge-not-exact-tested-head';
      if (!problem) transition(task, 'deploy', now);
      break;
    case 'deploy':
      problem = state.mode === 'real' ? null : deploymentGate(task, receipt, state.mode);
      if (!problem) transition(task, 'accept', now);
      break;
    case 'accept':
      problem = state.mode === 'real' ? null : acceptanceGate(task, receipt, state.mode);
      if (!problem) {
        task.status = 'delivered';
        task.delivery = state.simulated ? 'SIMULATED' : 'PHYSICAL';
        task.updatedAt = now;
        task.lastProgressAt = now;
      }
      break;
  }
  if (problem) block(task, problem, now);
}

/**
 * One deterministic transition/adapter dispatch. Persist is awaited BEFORE dispatch and
 * AFTER receipt. Adapters must deduplicate context.idempotencyKey across process restarts.
 * An exception leaves the intent unresolved; {transient:true} schedules a bounded retry
 * of that same key. Pending jobs reuse the key and receive their previous pending receipt.
 * Non-idempotent handoffs must await context.checkpointPending before the remote effect.
 */
export async function advance(input, adapter, { now = Date.now(), persist = async () => {}, stop = false } = {}) {
  assertState(input);
  now = time(now);
  if (now < input.updatedAt) now = input.updatedAt;
  const state = clone(input);
  if (TERMINAL.has(state.status)) return state;
  const save = async () => {
    state.updatedAt = now;
    await persist(clone(state));
    return state;
  };
  if (stop) {
    state.status = 'stopped';
    state.nextWakeAt = null;
    return save();
  }
  state.status = 'running';
  if (now >= state.expiresAt || state.actionCount >= state.limits.maxActions) {
    for (const task of state.tasks) {
      if (!TERMINAL.has(task.status)) block(task, now >= state.expiresAt ? 'experiment-expired' : 'action-limit', now);
    }
    settle(state, now);
    return save();
  }
  settle(state, now);
  if (TERMINAL.has(state.status)) return save();
  let task = state.tasks.find((item) => item.id === state.activeTaskId);
  if (!task || TERMINAL.has(task.status) || task.status === 'repair') {
    task = state.tasks.find((item) => item.status === 'queued' &&
      item.dependsOn.every((id) => state.tasks.find((dependency) => dependency.id === id)?.status === 'delivered'));
    if (!task) {
      for (const item of state.tasks) if (!TERMINAL.has(item.status)) block(item, 'no-runnable-task', now);
      settle(state, now);
      return save();
    }
    state.activeTaskId = task.id;
    task.status = 'running';
    task.lastProgressAt = now;
  }
  if (now - task.lastProgressAt >= state.limits.noProgressMs) {
    block(task, 'no-progress-expired', now);
    settle(state, now);
    return save();
  }
  if (task.nextActionAt && now < task.nextActionAt) {
    summarize(state);
    return save();
  }
  const action = task.stage;
  if (action === 'merge') {
    const problem = validationGate(task, state.mode);
    if (problem) {
      block(task, problem, now);
      settle(state, now);
      return save();
    }
  }
  if (['repair', 'implement', 'pr'].includes(action) && task.evidence.merge?.merged) {
    block(task, 'cannot-mutate-merged-pr', now);
    settle(state, now);
    return save();
  }
  if (!task.intent) {
    if ((task.attempts[action] ?? 0) >= state.limits.maxStageAttempts ||
        (action === 'repair' && task.repairCount >= state.limits.maxRepairs)) {
      block(task, action === 'repair' ? 'repair-limit' : 'stage-attempt-limit', now);
      settle(state, now);
      return save();
    }
    const attempt = task.attempts[action] = (task.attempts[action] ?? 0) + 1;
    if (action === 'repair') task.repairCount++;
    task.intent = {
      key: digest(`${state.runId}/${task.id}/${action}/${attempt}`),
      action,
      attempt,
      createdAt: now,
      dispatchCount: 0,
      pollCount: 0,
      pending: null,
    };
    task.history.push({ type: 'intent', action, key: task.intent.key, at: now });
  }
  const intent = task.intent;
  if (intent.action !== action) throw new Error('Intent/stage mismatch');
  if (state.mode === 'real' && INFERENCE_ACTIONS.includes(action)) {
    try {
      const existing = state.budget.reservations.find(item => item.key === intent.key);
      const costBound = existing ? existing : await adapter.quoteInferenceBudget?.(action, freeze(clone(task)), freeze({
        mode: state.mode, now, runId: state.runId, idempotencyKey: intent.key,
        attempt: intent.attempt, evidence: clone(task.evidence),
      }));
      reserveInferenceBudget(state, adapter.config, {
        key: intent.key, action, taskId: task.id, runId: state.runId,
        reservedUsdCents: costBound?.reservedUsdCents, now,
      });
    } catch (error) {
      block(task, error instanceof BudgetError ? error.code : 'budget-cost-bound-unavailable', now);
      settle(state, now);
      return save();
    }
  }
  if (intent.pending && intent.pollCount >= state.limits.maxPolls) {
    block(task, 'poll-limit', now);
    settle(state, now);
    return save();
  }
  if (intent.pending) intent.pollCount++;
  intent.dispatchCount++;
  state.actionCount++;
  task.status = 'running';
  task.nextActionAt = null;
  await save();
  let result;
  let checkpointOpen = true;
  const checkpointPending = async receipt => {
    if (!checkpointOpen || intent.pending) throw new Error('Pending checkpoint is closed or already recorded');
    if (!receipt || receipt.pending !== true || receipt.simulated !== state.simulated ||
        !Number.isSafeInteger(receipt.nextPollAt) || receipt.nextPollAt <= now) {
      throw new Error('Invalid pending checkpoint');
    }
    intent.pending = clone(receipt);
    task.history.push({ type: 'pending-checkpoint', action, key: intent.key, at: now, receipt: clone(receipt) });
    task.status = 'waiting';
    task.nextActionAt = receipt.nextPollAt;
    summarize(state);
    await save();
  };
  try {
    result = await adapter.execute(action, freeze(clone(task)), freeze({
      mode: state.mode,
      now,
      runId: state.runId,
      idempotencyKey: intent.key,
      attempt: intent.attempt,
      poll: Boolean(intent.pending),
      previousReceipt: clone(intent.pending),
      evidence: clone(task.evidence),
      checkpointPending,
    }));
  } catch (error) {
    if (!error?.transient) throw error;
    result = { transient: true, message: String(error.message) };
  } finally {
    checkpointOpen = false;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    block(task, 'invalid-adapter-receipt', now);
  } else if (result.transient === true) {
    task.retries[action] = (task.retries[action] ?? 0) + 1;
    task.history.push({ type: 'transient', action, key: intent.key, at: now, message: String(result.message ?? '') });
    if (task.retries[action] > state.limits.maxRetries) block(task, 'transient-retry-limit', now);
    else wait(task, now, task.retries[action], state.limits);
  } else if (result.simulated !== state.simulated) {
    block(task, 'simulated-evidence-mode-mismatch', now);
  } else if (result.pending === true) {
    if (!Number.isSafeInteger(result.nextPollAt) || result.nextPollAt <= now) {
      block(task, 'invalid-poll-deadline', now);
    } else {
      intent.pending = clone(result);
      task.history.push({ type: 'pending', action, key: intent.key, at: now, receipt: clone(result) });
      task.status = 'waiting';
      task.nextActionAt = result.nextPollAt;
    }
  } else if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(result.verdict)) {
    block(task, 'invalid-verdict', now);
  } else {
    if (state.mode === 'real' && INFERENCE_ACTIONS.includes(action)) {
      try {
        settleInferenceBudget(state, intent.key, result.inferenceBilling, now);
      } catch (error) {
        block(task, error instanceof BudgetError ? error.code : 'budget-settlement-unavailable', now);
        settle(state, now);
        return save();
      }
    }
    if (state.mode === 'real' && ['deploy', 'accept'].includes(action)) {
      if (result.verdict === 'PASS' || isPrivateDeviceReceipt(result)) {
        try {
          if (!isPrivateDeviceReceipt(result) || validationGate(task, 'real')) {
            throw new Error('Concrete private execution and independent validation are required');
          }
          validateDeviceReceipt(result, {
            task, runId: state.runId, deployKey: action === 'deploy' ? intent.key : task.evidence.deploy?.deployKey,
            now: Math.max(now, Date.now()),
          });
        } catch {
          // Rejected private payloads must never be copied into the public ledger/history.
          block(task, 'invalid-private-device-receipt', now);
          settle(state, now);
          return save();
        }
      } else {
        result = { verdict: result.verdict, simulated: false, reasonCode: 'PRIVATE_DEVICE_NOT_ACCEPTED' };
      }
    }
    const receipt = { ...clone(result), key: intent.key, recordedAt: now };
    task.evidence[action] = receipt;
    task.history.push({ type: 'receipt', action, key: intent.key, at: now, receipt: clone(receipt) });
    task.intent = null;
    applyReceipt(state, task, action, receipt, now);
  }
  settle(state, now);
  return save();
}

export async function runLoop(input, adapter, {
  persist = async () => {},
  now = Date.now,
  stop = () => false,
  maxSteps = 1000,
  virtualTime = false,
} = {}) {
  if (virtualTime && input.mode !== 'mock') throw new Error('Virtual time is only permitted for mock runs');
  let state = input;
  let virtualNow = Math.max(time(typeof now === 'function' ? now() : now), input.updatedAt);
  for (let step = 0; step < maxSteps; step++) {
    const current = virtualTime ? virtualNow : time(typeof now === 'function' ? now() : now);
    state = await advance(state, adapter, { now: current, persist, stop: await stop() });
    if (TERMINAL.has(state.status) || state.status === 'stopped') return state;
    if (state.status === 'waiting') {
      if (!virtualTime) return state;
      virtualNow = Math.max(current, state.nextWakeAt);
    }
  }
  return state;
}
