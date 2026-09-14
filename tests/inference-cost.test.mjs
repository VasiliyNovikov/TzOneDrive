import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertBudgetLedger, createBudgetLedger, reserveInferenceBudget, settleInferenceBudget
} from '../factory/budget.mjs';
import { createAdapter } from '../factory/github-adapter.mjs';
import { BILLABLE_UNITS, preCallCostBound, settleInferenceUsage } from '../factory/inference-cost.mjs';

const shippedConfig = JSON.parse(await readFile(new URL('../factory/trusted-config.json', import.meta.url), 'utf8'));

const code = expected => error => error.code === expected;

// SYNTHETIC TEST SCAFFOLDING ONLY. These rates and bounds are invented to exercise
// control logic offline. They are not an owner-reviewed billing reference and must
// never be copied into trusted configuration.
function source(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic-unit-test-cost-source',
    verified: true,
    method: 'owner-reviewed-official-billing-documentation',
    cli: { package: '@github/copilot', version: '1.0.83' },
    unit: 'ai-credits',
    usdCentsPerUnit: 1,
    preCallBound: {
      enforceable: true,
      includesHiddenRetries: true,
      mechanism: 'synthetic test bound',
      maxUnitsPerInvocation: 250
    },
    settlement: { available: true, unit: 'ai-credits', provenance: 'backend-reported' },
    evidence: ['synthetic-billing-note'],
    ...overrides
  };
}

test('production configuration carries no verified cost source, so billable dispatch stays blocked', async () => {
  assert.equal(shippedConfig.inferenceCostSource, undefined);
  assert.throws(() => preCallCostBound(shippedConfig.inferenceCostSource, { action: 'plan' }),
    code('budget-cost-source-unverified'));
  const adapter = await createAdapter({ token: 'unused-test-token', config: shippedConfig, env: {} });
  await assert.rejects(adapter.quoteInferenceBudget('plan'), code('budget-cost-source-unverified'));
});

test('unverified, unattributed or non-billing cost sources are refused', () => {
  for (const [overrides, expected] of [
    [{ verified: false }, 'budget-cost-source-unverified'],
    [{ method: 'model-output' }, 'budget-cost-source-unverified'],
    [{ id: '' }, 'budget-cost-source-unverified'],
    [{ cli: { package: '@github/copilot', version: '1.0.84' } }, 'budget-cost-source-unverified'],
    [{ evidence: [] }, 'budget-cost-source-unverified'],
    [{ unit: 'tokens' }, 'budget-cost-units-unconvertible'],
    [{ unit: 'nano-aiu' }, 'budget-cost-units-unconvertible'],
    [{ unit: 'copilot-cost-multiplier' }, 'budget-cost-units-unconvertible'],
    [{ usdCentsPerUnit: 0 }, 'budget-cost-units-unconvertible'],
    [{ usdCentsPerUnit: 4 }, 'budget-cost-units-unconvertible'],
    [{ unit: 'usd-cents', usdCentsPerUnit: 100 }, 'budget-cost-units-unconvertible']
  ]) {
    assert.throws(() => preCallCostBound(source(overrides), { action: 'plan' }), code(expected));
  }
  assert.deepEqual([...BILLABLE_UNITS], ['ai-credits', 'premium-requests', 'usd-cents']);
  assert.equal(preCallCostBound(source({
    unit: 'premium-requests', usdCentsPerUnit: 4,
    settlement: { available: true, unit: 'premium-requests', provenance: 'backend-reported' }
  }), { action: 'plan' }).reservedUsdCents, 1000);
});

test('a soft post-call cap or an unbounded retry path is not an enforceable pre-call bound', () => {
  for (const preCallBound of [
    { enforceable: false, includesHiddenRetries: true, mechanism: 'checked after each model call returns', maxUnitsPerInvocation: 250 },
    { enforceable: true, includesHiddenRetries: false, mechanism: 'per-prompt estimate', maxUnitsPerInvocation: 250 },
    { enforceable: true, includesHiddenRetries: true, mechanism: 'bound', maxUnitsPerInvocation: 0 },
    { enforceable: true, includesHiddenRetries: true, mechanism: '', maxUnitsPerInvocation: 10 }
  ]) {
    assert.throws(() => preCallCostBound(source({ preCallBound }), { action: 'plan' }),
      code('budget-cost-bound-unavailable'));
  }
  for (const settlement of [
    { available: false, unit: 'ai-credits', provenance: 'backend-reported' },
    { available: true, unit: 'premium-requests', provenance: 'backend-reported' },
    { available: true, unit: 'ai-credits', provenance: 'assumed' }
  ]) {
    assert.throws(() => preCallCostBound(source({ settlement }), { action: 'plan' }),
      code('budget-settlement-unavailable'));
  }
  assert.throws(() => preCallCostBound(source(), { action: 'accept' }), code('budget-invalid-action'));
});

test('settlement requires backend-reported usage in the verified billable unit', () => {
  const key = 'call-1';
  assert.throws(() => settleInferenceUsage(source(), null, { settlementKey: key }),
    code('budget-settlement-unavailable'));
  assert.throws(() => settleInferenceUsage(source(), { unit: 'ai-credits', amount: 3 }, {}),
    code('budget-settlement-unavailable'));
  for (const usage of [{ unit: 'tokens', amount: 5000 }, { unit: 'nano-aiu', amount: 1500 }]) {
    assert.throws(() => settleInferenceUsage(source(), usage, { settlementKey: key }),
      code('budget-cost-units-unconvertible'));
  }
  assert.throws(() => settleInferenceUsage(source(), { unit: 'ai-credits', amount: -1 }, { settlementKey: key }),
    code('budget-settlement-unavailable'));
  assert.throws(() => settleInferenceUsage(source(), { unit: 'ai-credits', amount: 251 }, { settlementKey: key }),
    code('budget-cost-bound-exceeded'));
  const settlement = settleInferenceUsage(source(), { unit: 'ai-credits', amount: 42 }, { settlementKey: key });
  assert.deepEqual({ ...settlement }, { costUsdCents: 42, settlementKey: key, source: 'synthetic-unit-test-cost-source' });
  assert.equal(settleInferenceUsage(source(), { unit: 'ai-credits', amount: 0 }, { settlementKey: key }).costUsdCents, 0);
});

test('verified bounds reserve, settle idempotently and accumulate across restarts', () => {
  const config = { inferenceBudget: { cumulativeCapUsdCents: 1000 } };
  const state = { budget: createBudgetLedger() };
  const bound = preCallCostBound(source(), { action: 'plan' });
  const identity = { key: 'intent-1', action: 'plan', taskId: 'task-1', runId: 'run-1' };
  reserveInferenceBudget(state, config, { ...identity, reservedUsdCents: bound.reservedUsdCents, now: 1 });
  // A concurrent or restarted dispatch reuses the same durable reservation.
  const again = reserveInferenceBudget(state, config, { ...identity, reservedUsdCents: bound.reservedUsdCents, now: 2 });
  assert.equal(again.status, 'reserved');
  assert.equal(state.budget.reservedUsdCents, 250);
  const settlement = settleInferenceUsage(source(), { unit: 'ai-credits', amount: 42 }, { settlementKey: 'call-1' });
  settleInferenceBudget(state, identity.key, settlement, 3);
  settleInferenceBudget(state, identity.key, settlement, 4);
  assert.equal(state.budget.cumulativeSpendUsdCents, 42);
  assert.equal(state.budget.reservedUsdCents, 0);
  const restored = { budget: JSON.parse(JSON.stringify(state.budget)) };
  assertBudgetLedger(restored.budget);
  reserveInferenceBudget(restored, config, {
    key: 'intent-2', action: 'implement', taskId: 'task-1', runId: 'run-1',
    reservedUsdCents: bound.reservedUsdCents, now: 5
  });
  assert.equal(restored.budget.cumulativeSpendUsdCents, 42);
  assert.throws(() => reserveInferenceBudget(restored, config, {
    key: 'intent-3', action: 'repair', taskId: 'task-1', runId: 'run-1', reservedUsdCents: 800, now: 6
  }), code('budget-exhausted'));
});

test('an unresolved outcome keeps its reservation instead of silently becoming zero', () => {
  const config = { inferenceBudget: { cumulativeCapUsdCents: 1000 } };
  const state = { budget: createBudgetLedger() };
  const identity = { key: 'intent-1', action: 'plan', taskId: 'task-1', runId: 'run-1' };
  reserveInferenceBudget(state, config, { ...identity, reservedUsdCents: 250, now: 1 });
  assert.throws(() => settleInferenceBudget(state, identity.key, undefined, 2),
    code('budget-settlement-unavailable'));
  assert.equal(state.budget.unresolvedUsdCents, 250);
  assert.equal(state.budget.cumulativeSpendUsdCents, 0);
  assert.throws(() => reserveInferenceBudget(state, config, { ...identity, reservedUsdCents: 250, now: 3 }),
    code('budget-reservation-unavailable'));
  assertBudgetLedger(state.budget);
});
