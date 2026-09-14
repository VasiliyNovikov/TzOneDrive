import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createState, advance, runLoop } from '../factory/controller.mjs';
import {
  budgetVisibility, reserveInferenceBudget, settleInferenceBudget, validateTrustedBudget
} from '../factory/budget.mjs';
import { createMockAdapter } from '../factory/main.mjs';
import { StateLockedError, withStore } from '../factory/store.mjs';

const NOW = 1000000;
const backlog = [{ id: 'feature', goal: 'Show trusted fixture files on the TV.' }];
const initial = (limits = {}, mode = 'mock') => createState(backlog, { now: NOW, mode, limits });
const drive = (state, adapter, extra = {}) => runLoop(state, adapter, { now: NOW, virtualTime: state.mode === 'mock', ...extra });
const budgetConfig = cap => ({ inferenceBudget: { cumulativeCapUsdCents: cap } });

async function fixture(t) {
  const directory = resolve('.factory-local', `test-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('trusted goals, IDs, dependency graph, and modes are validated', async () => {
  assert.throws(() => createState([{ id: '../command', goal: 'x' }]), /IDs/);
  assert.throws(() => createState([{ id: 'a', goal: 'x', dependsOn: ['missing'] }]), /Unknown dependency/);
  assert.throws(() => createState([{ id: 'a', goal: 'x', dependsOn: ['b'] }, { id: 'b', goal: 'y', dependsOn: ['a'] }]), /cycle/);
  assert.throws(() => initial({ maxActions: -1 }), /Invalid limit/);
  const state = initial();
  state.tasks[0].goal = 'Mutated';
  await assert.rejects(advance(state, {}), /mutated trusted goal/);
  const corrupt = initial();
  delete corrupt.limits.maxActions;
  await assert.rejects(advance(corrupt, {}), /Invalid limits/);
  const corruptCounter = initial();
  corruptCounter.actionCount = null;
  await assert.rejects(advance(corruptCounter, {}), /Invalid durable counters/);
});

test('trusted inference budget config uses integer cumulative USD cents', () => {
  assert.deepEqual(validateTrustedBudget(budgetConfig(500000)), { cumulativeCapUsdCents: 500000 });
  for (const inferenceBudget of [
    undefined, {}, { cumulativeCapUsdCents: 1.5 }, { cumulativeCapUsdCents: -1 },
    { cumulativeCapUsdCents: 500000, resetsMonthly: true }
  ]) {
    assert.throws(() => validateTrustedBudget({ inferenceBudget }), /cumulativeCapUsdCents|trusted config/);
  }
});

test('inference budget is cumulative across run IDs and cap changes do not reset accounting', () => {
  const state = initial({}, 'real');
  const first = { key: 'first', action: 'plan', taskId: 'feature', runId: 'run-a', reservedUsdCents: 300, now: NOW };
  reserveInferenceBudget(state, budgetConfig(500), first);
  settleInferenceBudget(state, first.key, { settlementKey: 'receipt-a', costUsdCents: 300, source: 'trusted-test' }, NOW + 1);
  assert.equal(state.budget.cumulativeSpendUsdCents, 300);

  reserveInferenceBudget(state, budgetConfig(1000),
    { key: 'second', action: 'plan', taskId: 'feature', runId: 'run-b', reservedUsdCents: 600, now: NOW + 2 });
  assert.equal(budgetVisibility(state.budget, budgetConfig(1000)).availableUsdCents, 100);
  assert.throws(() => reserveInferenceBudget(state, budgetConfig(800),
    { key: 'third', action: 'plan', taskId: 'feature', runId: 'run-c', reservedUsdCents: 1, now: NOW + 3 }), /exhausted/);
  assert.equal(state.budget.cumulativeSpendUsdCents, 300);
});

test('inference budget enforces exact cap boundary and concurrent reservations', () => {
  const state = initial({}, 'real');
  reserveInferenceBudget(state, budgetConfig(100),
    { key: 'a', action: 'plan', taskId: 'feature', runId: 'run', reservedUsdCents: 60, now: NOW });
  assert.throws(() => reserveInferenceBudget(state, budgetConfig(100),
    { key: 'b', action: 'implement', taskId: 'feature', runId: 'run', reservedUsdCents: 50, now: NOW }), /exhausted/);
  settleInferenceBudget(state, 'a', { settlementKey: 'settle-a', costUsdCents: 20, source: 'trusted-test' }, NOW + 1);
  reserveInferenceBudget(state, budgetConfig(100),
    { key: 'b', action: 'implement', taskId: 'feature', runId: 'run', reservedUsdCents: 50, now: NOW + 2 });
  reserveInferenceBudget(state, budgetConfig(100),
    { key: 'c', action: 'validate', taskId: 'feature', runId: 'run', reservedUsdCents: 30, now: NOW + 3 });
  assert.equal(budgetVisibility(state.budget, budgetConfig(100)).availableUsdCents, 0);
});

test('inference budget settlement is idempotent and unknown costs stay unresolved', () => {
  const state = initial({}, 'real');
  reserveInferenceBudget(state, budgetConfig(1000),
    { key: 'known', action: 'repair', taskId: 'feature', runId: 'run', reservedUsdCents: 100, now: NOW });
  settleInferenceBudget(state, 'known', { settlementKey: 'same-receipt', costUsdCents: 25, source: 'trusted-test' }, NOW + 1);
  settleInferenceBudget(state, 'known', { settlementKey: 'same-receipt', costUsdCents: 25, source: 'trusted-test' }, NOW + 2);
  assert.equal(state.budget.cumulativeSpendUsdCents, 25);
  assert.throws(() => settleInferenceBudget(state, 'known',
    { settlementKey: 'different-receipt', costUsdCents: 25, source: 'trusted-test' }, NOW + 3), /mismatch/);

  reserveInferenceBudget(state, budgetConfig(1000),
    { key: 'unknown', action: 'validate', taskId: 'feature', runId: 'run', reservedUsdCents: 200, now: NOW + 4 });
  assert.throws(() => settleInferenceBudget(state, 'unknown', null, NOW + 5), /usage\/cost/);
  assert.equal(state.budget.reservations.find(item => item.key === 'unknown').status, 'unresolved');
  assert.equal(budgetVisibility(state.budget, budgetConfig(1000)).unresolvedUsdCents, 200);
});

test('mock completes the full lifecycle; completed state dispatches nothing on resume', async () => {
  const adapter = await createMockAdapter();
  const state = await drive(initial(), adapter);
  assert.equal(state.status, 'delivered');
  assert.equal(state.tasks[0].delivery, 'SIMULATED');
  assert.deepEqual(state.tasks[0].history.filter((item) => item.type === 'receipt').map((item) => item.action),
    ['plan', 'implement', 'pr', 'validate', 'merge', 'deploy', 'accept']);
  const resumed = await drive(state, { execute() { assert.fail('Must not rerun delivered task'); } });
  assert.deepEqual(resumed, state);
  assert.equal(Object.keys(adapter.ledger.effects).length, 7);
});

test('only one active task executes; dependencies wait for delivery', async () => {
  const state = createState([
    { id: 'second', goal: 'Dependent', dependsOn: ['first'] },
    { id: 'first', goal: 'Prerequisite' },
  ], { now: NOW });
  const adapter = await createMockAdapter();
  const result = await drive(state, adapter, { persist(next) {
    assert.ok(next.tasks.filter((task) => ['running', 'waiting'].includes(task.status)).length <= 1);
    if (next.tasks[0].attempts.plan) assert.equal(next.tasks[1].status, 'delivered');
  } });
  assert.equal(result.status, 'delivered');
  assert.equal(result.actionCount, 14);
});

test('intent is persisted before side effect; receipt is persisted afterwards', async () => {
  const checkpoints = [];
  const result = await advance(initial(), {
    execute(action, task, context) {
      const before = checkpoints.at(-1);
      assert.equal(before.tasks[0].intent.key, context.idempotencyKey);
      assert.equal(before.actionCount, 1);
      assert.match(context.idempotencyKey, /^[a-f0-9]{64}$/);
      assert.ok(Object.isFrozen(task));
      assert.ok(Object.isFrozen(context.evidence));
      return { simulated: true, verdict: 'PASS', plan: 'SIMULATED plan' };
    },
  }, { now: NOW, persist: async (state) => checkpoints.push(structuredClone(state)) });
  assert.equal(checkpoints.length, 2);
  assert.equal(result.tasks[0].intent, null);
  assert.equal(result.tasks[0].evidence.plan.verdict, 'PASS');
});

test('real inference requires a pre-call budget reservation and settled trustworthy cost', async () => {
  let executed = false;
  let state = await advance(initial({}, 'real'), {
    config: budgetConfig(500000),
    execute() { executed = true; },
  }, { now: NOW });
  assert.equal(executed, false);
  assert.equal(state.status, 'blocked');
  assert.equal(state.tasks[0].blockedReason, 'budget-cost-bound-unavailable');

  state = await advance(initial({}, 'real'), {
    config: budgetConfig(500000),
    quoteInferenceBudget() { return { reservedUsdCents: 100 }; },
    execute() { return { simulated: false, verdict: 'PASS', plan: 'billable plan without cost' }; },
  }, { now: NOW });
  assert.equal(state.status, 'blocked');
  assert.equal(state.tasks[0].blockedReason, 'budget-settlement-unavailable');
  assert.equal(state.budget.reservations[0].status, 'unresolved');

  state = await advance(initial({}, 'real'), {
    config: budgetConfig(500000),
    quoteInferenceBudget() { return { reservedUsdCents: 100 }; },
    execute() {
      return {
        simulated: false, verdict: 'PASS', plan: 'billable plan',
        inferenceBilling: { settlementKey: 'call-1', costUsdCents: 75, source: 'trusted-test' }
      };
    },
  }, { now: NOW });
  assert.equal(state.tasks[0].stage, 'implement');
  assert.equal(state.budget.cumulativeSpendUsdCents, 75);
  assert.equal(state.budget.reservations[0].status, 'settled');
});

test('a failure saving intent prevents the side effect', async () => {
  await assert.rejects(advance(initial(), { execute() { assert.fail('not allowed'); } }, {
    now: NOW, persist() { throw new Error('disk unavailable'); },
  }), /disk unavailable/);
});

test('adapter checkpoint is durably saved before a non-idempotent effect and survives a crash', async () => {
  let durable;
  let checkpoint;
  const pending = { simulated: true, pending: true, jobId: 'job-one', nextPollAt: NOW + 5000 };
  const persist = next => { durable = structuredClone(next); };
  await assert.rejects(advance(initial(), {
    async execute(_action, _task, context) {
      checkpoint = context.checkpointPending;
      await checkpoint(pending);
      assert.deepEqual(durable.tasks[0].intent.pending, pending);
      assert.equal(durable.status, 'waiting');
      assert.equal(durable.nextWakeAt, pending.nextPollAt);
      pending.jobId = 'mutated-after-save';
      throw new Error('crash after checkpoint');
    }
  }, { now: NOW, persist }), /crash after checkpoint/);
  const key = durable.tasks[0].intent.key;
  assert.equal(durable.tasks[0].intent.pending.jobId, 'job-one');
  await assert.rejects(checkpoint(pending), /closed/);
  const resumed = await advance(durable, {
    execute(_action, _task, context) {
      assert.equal(context.idempotencyKey, key);
      assert.equal(context.poll, true);
      assert.equal(context.previousReceipt.jobId, 'job-one');
      return { simulated: true, verdict: 'PASS', plan: 'Recovered plan' };
    }
  }, { now: NOW + 5000, persist });
  assert.equal(resumed.tasks[0].stage, 'implement');
  assert.equal(resumed.tasks[0].attempts.plan, 1);
});

test('pending checkpoint persistence failure prevents the following remote effect', async () => {
  let writes = 0;
  let effects = 0;
  await assert.rejects(advance(initial(), {
    async execute(_action, _task, context) {
      await context.checkpointPending({ simulated: true, pending: true, nextPollAt: NOW + 5000 });
      effects++;
      return { simulated: true, pending: true, nextPollAt: NOW + 5000 };
    }
  }, { now: NOW, persist() {
    if (++writes === 2) throw new Error('checkpoint storage failed');
  } }), /checkpoint storage failed/);
  assert.equal(writes, 2);
  assert.equal(effects, 0);
});

test('pending checkpoint rejects mode/deadline changes and cannot overwrite an existing ticket', async () => {
  const pending = { simulated: true, pending: true, nextPollAt: NOW + 5000, jobId: 'job-one' };
  for (const invalid of [
    { ...pending, simulated: false }, { ...pending, pending: false },
    { ...pending, nextPollAt: NOW }, { ...pending, nextPollAt: 'later' }
  ]) {
    let writes = 0;
    await assert.rejects(advance(initial(), {
      execute(_action, _task, context) { return context.checkpointPending(invalid); }
    }, { now: NOW, persist() { writes++; } }), /Invalid pending checkpoint/);
    assert.equal(writes, 1);
  }
  const result = await advance(initial(), {
    async execute(_action, _task, context) {
      await context.checkpointPending(pending);
      await assert.rejects(context.checkpointPending({ ...pending, jobId: 'substituted' }), /already recorded/);
      return pending;
    }
  }, { now: NOW });
  assert.equal(result.tasks[0].intent.pending.jobId, 'job-one');
});

test('crash between effect and receipt resumes the same key without duplicate effect', async (t) => {
  const directory = await fixture(t);
  await assert.rejects(withStore(directory, async (store) => {
    await store.save(initial());
    await drive(await store.load(), await createMockAdapter({ stateDir: directory, scenario: 'crash' }), { persist: store.save });
  }), /SIMULATED crash/);
  await withStore(directory, async (store) => {
    const interrupted = await store.load();
    const key = interrupted.tasks[0].intent.key;
    assert.equal(interrupted.tasks[0].stage, 'implement');
    const adapter = await createMockAdapter({ stateDir: directory, scenario: 'crash' });
    const state = await drive(interrupted, adapter, { persist: store.save });
    assert.equal(state.status, 'delivered');
    assert.equal(Object.keys(adapter.ledger.effects).length, 7);
    assert.equal(adapter.ledger.calls[key], 2);
    assert.equal((await store.load()).status, 'delivered');
  });
});

test('mock receipts cannot advance a real run or become physical delivery', async () => {
  const mock = await createMockAdapter();
  const result = await drive(initial({}, 'real'), {
    config: budgetConfig(500000),
    quoteInferenceBudget() { return { reservedUsdCents: 100 }; },
    async execute(action, task, context) {
      const receipt = await mock.execute(action, task, context);
      if (['plan', 'implement', 'repair', 'validate'].includes(action)) {
        receipt.inferenceBilling = { settlementKey: context.idempotencyKey, costUsdCents: 1, source: 'trusted-test' };
      }
      return receipt;
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.tasks[0].blockedReason, 'simulated-evidence-mode-mismatch');
  assert.equal(result.tasks[0].evidence.merge, undefined);
  await assert.rejects(runLoop(initial({}, 'real'), {}, { virtualTime: true }), /only permitted for mock/);
});

test('legacy mock receipts cannot be relabelled into real delivery, even with physical-looking fields', async (t) => {
  for (const mode of ['real', 'emulator', 'mock', 'missing-camera', 'wrong-device', 'wrong-build']) {
    await t.test(mode, async () => {
      const mock = await createMockAdapter();
      const state = await drive(initial({}, 'real'), { async execute(action, task, context) {
        const receipt = await mock.execute(action, task, context);
        receipt.simulated = false;
        if (action === 'deploy' || action === 'accept') {
          receipt.deviceMode = ['emulator', 'mock'].includes(mode) ? mode : 'real';
          receipt.deviceId = 'physical-tv-test-fixture';
        }
        if (action === 'accept') {
          receipt.camera.source = 'physical-camera';
          if (mode === 'missing-camera') delete receipt.camera.artifact;
          if (mode === 'wrong-device') receipt.deviceId = 'different-tv';
          if (mode === 'wrong-build') receipt.buildId = 'different-build';
        }
        return receipt;
      } });
      assert.equal(state.status, 'blocked');
      assert.equal(state.tasks[0].delivery, undefined);
    });
  }
});

test('exact tested head, independent review, CI and package provenance are mandatory', async (t) => {
  const mutations = [
    ['tested SHA', (result) => { result.testedSha = 'a'.repeat(40); }],
    ['head SHA', (result) => { result.headSha = 'a'.repeat(40); }],
    ['independent review', (result) => { result.independentReview.independent = false; }],
    ['review PASS', (result) => { result.independentReview.verdict = 'FAIL'; }],
    ['CI', (result) => { result.ciPassed = false; }],
    ['package commit', (result) => { result.package.headSha = 'a'.repeat(40); }],
    ['package hash', (result) => { result.package.sha256 = 'invalid'; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const mock = await createMockAdapter();
    const state = await drive(initial(), { async execute(action, task, context) {
      assert.notEqual(action, 'merge');
      const result = await mock.execute(action, task, context);
      if (action === 'validate') mutate(result);
      return result;
    } });
    assert.equal(state.status, 'blocked');
  });
});

test('merge gate is checked again immediately before dispatch', async () => {
  const mock = await createMockAdapter();
  let state = initial();
  for (let i = 0; i < 4; i++) state = await advance(state, mock, { now: NOW });
  assert.equal(state.tasks[0].stage, 'merge');
  state.tasks[0].evidence.pr.headSha = 'b'.repeat(40);
  state = await advance(state, { execute() { assert.fail('merge must not dispatch'); } }, { now: NOW });
  assert.equal(state.status, 'blocked');
});

test('wrong merged head or deployed package cannot reach acceptance', async (t) => {
  for (const actionToBreak of ['merge', 'deploy']) await t.test(actionToBreak, async () => {
    const mock = await createMockAdapter();
    const state = await drive(initial(), { async execute(action, task, context) {
      assert.notEqual(action, 'accept');
      const result = await mock.execute(action, task, context);
      if (action === actionToBreak) result.headSha = 'f'.repeat(40);
      return result;
    } });
    assert.equal(state.status, 'blocked');
  });
});

test('validation failures get bounded repair and revalidation of a new head', async () => {
  const mock = await createMockAdapter();
  let validations = 0;
  const state = await drive(initial(), { async execute(action, task, context) {
    const result = await mock.execute(action, task, context);
    if (action === 'validate' && validations++ === 0) result.verdict = 'FAIL';
    return result;
  } });
  assert.equal(state.status, 'delivered');
  assert.equal(state.tasks[0].repairCount, 1);
  assert.equal(state.tasks[0].attempts.validate, 2);
  assert.equal(state.tasks[0].evidence.merge.headSha, state.tasks[0].evidence.validate.testedSha);
  const failing = await createMockAdapter();
  const exhausted = await drive(initial({ maxRepairs: 1 }), { async execute(action, task, context) {
    const result = await failing.execute(action, task, context);
    if (action === 'validate') result.verdict = 'FAIL';
    return result;
  } });
  assert.equal(exhausted.tasks[0].blockedReason, 'repair-limit');
});

test('post-merge physical failure creates a separate follow-up instead of mutating the merged PR', async () => {
  const adapter = await createMockAdapter({ scenario: 'navigation-failure' });
  const result = await drive(initial(), adapter);
  assert.equal(result.status, 'delivered');
  assert.equal(result.tasks.length, 2);
  const [original, followUp] = result.tasks;
  assert.equal(followUp.sourceTaskId, original.id);
  assert.equal(followUp.goal, original.goal);
  assert.equal(original.attempts.repair, undefined);
  assert.notEqual(original.evidence.pr.prNumber, followUp.evidence.pr.prNumber);
  assert.equal(original.evidence.accept.verdict, 'FAIL');
  assert.equal(followUp.evidence.accept.verdict, 'PASS');
});

test('repeated physical failure is bounded across follow-up tasks', async () => {
  const mock = await createMockAdapter();
  const state = await drive(initial({ maxFollowUps: 1 }), { async execute(action, task, context) {
    const result = await mock.execute(action, task, context);
    if (action === 'accept') result.verdict = 'FAIL';
    return result;
  } });
  assert.equal(state.status, 'blocked');
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[1].blockedReason, 'physical-repair-limit');
});

test('missing camera is INCONCLUSIVE, bounded, and never delivered; fallback is blocked', async () => {
  const missing = await drive(initial(), await createMockAdapter({ scenario: 'missing-camera' }));
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.tasks[0].attempts.accept, 3);
  assert.equal(missing.tasks[0].blockedReason, 'inconclusive-limit');
  const fallback = await drive(initial(), await createMockAdapter({ scenario: 'fallback' }));
  assert.equal(fallback.status, 'blocked');
  assert.equal(fallback.tasks[0].evidence.accept, undefined);
});

test('transient retries preserve key, use exponential deadlines, and never busy sleep', async () => {
  let calls = 0;
  const keys = [];
  const adapter = { execute(action, task, context) {
    calls++;
    keys.push(context.idempotencyKey);
    return { transient: true, message: 'rate limited' };
  } };
  let state = await advance(initial({ maxRetries: 2 }), adapter, { now: NOW });
  assert.equal(state.nextWakeAt, NOW + 1000);
  state = await advance(state, adapter, { now: NOW + 500 });
  assert.equal(calls, 1);
  state = await advance(state, adapter, { now: NOW + 1000 });
  assert.equal(state.nextWakeAt, NOW + 3000);
  state = await advance(state, adapter, { now: NOW + 3000 });
  assert.equal(state.tasks[0].blockedReason, 'transient-retry-limit');
  assert.equal(new Set(keys).size, 1);
  const success = await drive(initial(), await createMockAdapter({ scenario: 'transient' }));
  assert.equal(success.status, 'delivered');
});

test('pending jobs persist their receipt and key and do not consume new stage attempts', async () => {
  const contexts = [];
  const adapter = { execute(action, task, context) {
    contexts.push(context);
    return contexts.length === 1
      ? { simulated: true, pending: true, jobId: 'job-1', nextPollAt: NOW + 5000 }
      : { simulated: true, verdict: 'PASS', plan: 'Completed async plan' };
  } };
  let state = await advance(initial(), adapter, { now: NOW });
  assert.equal(state.tasks[0].status, 'waiting');
  state = await advance(state, adapter, { now: NOW + 4999 });
  assert.equal(contexts.length, 1);
  state = await advance(state, adapter, { now: NOW + 5000 });
  assert.equal(contexts[1].poll, true);
  assert.equal(contexts[1].previousReceipt.jobId, 'job-1');
  assert.equal(contexts[0].idempotencyKey, contexts[1].idempotencyKey);
  assert.equal(state.tasks[0].attempts.plan, 1);
  assert.equal(state.tasks[0].stage, 'implement');
});

test('pending/no-progress work is bounded by polls, actions, experiment and elapsed progress', async (t) => {
  for (const [limits, reason] of [
    [{ maxPolls: 2 }, 'poll-limit'],
    [{ maxActions: 2 }, 'action-limit'],
    [{ experimentMs: 1500 }, 'experiment-expired'],
    [{ noProgressMs: 1500 }, 'no-progress-expired'],
  ]) await t.test(reason, async () => {
    const result = await drive(initial(limits), await createMockAdapter({ scenario: 'no-progress' }));
    assert.equal(result.status, 'blocked');
    assert.equal(result.tasks[0].blockedReason, reason);
    assert.ok(result.actionCount <= result.limits.maxActions);
  });
});

test('ordinary failed stages have bounded attempts and blocked dependencies', async () => {
  const state = createState([
    ...backlog,
    { id: 'dependent', goal: 'Wait for feature', dependsOn: ['feature'] },
  ], { now: NOW, limits: { maxStageAttempts: 2 } });
  const result = await drive(state, { execute() { return { simulated: true, verdict: 'FAIL' }; } });
  assert.equal(result.tasks[0].blockedReason, 'stage-attempt-limit');
  assert.equal(result.tasks[1].blockedReason, 'dependency-blocked');
});

test('STOP is checked before dispatch and can be resumed when removed', async (t) => {
  const directory = await fixture(t);
  await withStore(directory, async (store) => {
    await writeFile(join(directory, 'STOP'), '');
    const stopped = await drive(initial(), { execute() { assert.fail('stopped'); } }, { stop: store.shouldStop, persist: store.save });
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.actionCount, 0);
    await rm(join(directory, 'STOP'));
    const resumed = await drive(await store.load(), await createMockAdapter(), { stop: store.shouldStop, persist: store.save });
    assert.equal(resumed.status, 'delivered');
  });
});

test('disk store is atomic, persistent, exclusive, and releases locks after errors', async (t) => {
  const directory = await fixture(t);
  let leakedStore;
  await assert.rejects(withStore(directory, async (store) => {
    leakedStore = store;
    await store.save(initial());
    assert.deepEqual(await store.load(), initial());
    await assert.rejects(withStore(directory, () => {}), StateLockedError);
    throw new Error('callback failed');
  }), /callback failed/);
  assert.throws(() => leakedStore.save(initial()), /Cannot save after releasing/);
  await withStore(directory, async (store) => assert.equal((await store.load()).version, 1));
  assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).version, 1);
});

test('STOP environment flag stops the CLI without dispatch', async (t) => {
  const directory = await fixture(t);
  const child = spawnSync(process.execPath, ['factory/main.mjs', 'mock', '--state-dir', directory], {
    encoding: 'utf8', env: { ...process.env, FACTORY_STOP: '1' },
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'stopped');
  assert.equal(result.actionCount, 0);
});

test('dead process lock is reclaimed after a real process crash', async (t) => {
  const directory = await fixture(t);
  const script = `import {withStore} from './factory/store.mjs'; await withStore(${JSON.stringify(directory)}, async () => process.exit(9));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 9, child.stderr);
  await withStore(directory, async (store) => {
    await store.save(initial());
    assert.equal((await store.load()).version, 1);
  });
});

test('CLI persists a run, resumes without duplicate effects, and refuses mock-to-real state', async (t) => {
  const directory = await fixture(t);
  const args = ['factory/main.mjs', 'mock', '--state-dir', directory];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'delivered');
  const ledger = await readFile(join(directory, 'mock-effects.json'), 'utf8');
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(join(directory, 'mock-effects.json'), 'utf8'), ledger);
  const real = spawnSync(process.execPath, ['factory/main.mjs', 'real', '--state-dir', directory], { encoding: 'utf8' });
  assert.equal(real.status, 1);
  assert.match(real.stderr, /Cannot reuse mock state/);
});

test('CLI can resume the same initialization arguments but cannot mutate its trusted backlog', async (t) => {
  const directory = await fixture(t);
  const args = ['factory/main.mjs', 'mock', '--state-dir', directory, '--goal', 'Trusted immutable goal', '--max-actions', '30'];
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'delivered');
  }
  const changed = [...args];
  changed[changed.indexOf('--goal') + 1] = 'Different goal';
  const result = spawnSync(process.execPath, changed, { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /trusted backlog is immutable/);
});

test('CLI crash resumes persisted scenario even when --scenario is omitted', async (t) => {
  const directory = await fixture(t);
  const args = ['factory/main.mjs', 'mock', '--state-dir', directory];
  const crash = spawnSync(process.execPath, [...args, '--scenario', 'crash'], { encoding: 'utf8' });
  assert.equal(crash.status, 1);
  assert.match(crash.stderr, /SIMULATED crash/);
  const resumed = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, 'delivered');
  const ledger = JSON.parse(await readFile(join(directory, 'mock-effects.json'), 'utf8'));
  assert.equal(Object.keys(ledger.effects).length, 7);
});
