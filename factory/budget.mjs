export const DEFAULT_CUMULATIVE_CAP_USD_CENTS = 500000;

export const INFERENCE_ACTIONS = Object.freeze(['plan', 'implement', 'repair', 'validate']);

const STATUS = new Set(['reserved', 'settled', 'unresolved']);

export class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function validateTrustedBudget(config) {
  const budget = config?.inferenceBudget;
  if (!budget || Object.keys(budget).some(key => key !== 'cumulativeCapUsdCents') ||
      !Number.isSafeInteger(budget.cumulativeCapUsdCents) || budget.cumulativeCapUsdCents < 0) {
    throw new BudgetError('budget-invalid-config',
      'Trusted config must define inferenceBudget.cumulativeCapUsdCents as nonnegative integer USD cents');
  }
  return { cumulativeCapUsdCents: budget.cumulativeCapUsdCents };
}

export function createBudgetLedger() {
  return {
    schemaVersion: 1,
    cumulativeSpendUsdCents: 0,
    reservedUsdCents: 0,
    unresolvedUsdCents: 0,
    reservations: {}
  };
}

export function assertBudgetLedger(budget) {
  if (budget?.schemaVersion !== 1 || !Number.isSafeInteger(budget.cumulativeSpendUsdCents) ||
      budget.cumulativeSpendUsdCents < 0 || !Number.isSafeInteger(budget.reservedUsdCents) ||
      budget.reservedUsdCents < 0 || !Number.isSafeInteger(budget.unresolvedUsdCents) ||
      budget.unresolvedUsdCents < 0 || !budget.reservations || Array.isArray(budget.reservations) ||
      typeof budget.reservations !== 'object') {
    throw new BudgetError('budget-invalid-ledger', 'Invalid inference budget accounting');
  }
  const keys = new Set();
  let settled = 0;
  let reserved = 0;
  let unresolved = 0;
  for (const [key, item] of Object.entries(budget.reservations)) {
    if (!item || typeof item.key !== 'string' || item.key !== key || keys.has(item.key) || !STATUS.has(item.status) ||
        !INFERENCE_ACTIONS.includes(item.action) || typeof item.taskId !== 'string' ||
        typeof item.runId !== 'string' || !Number.isSafeInteger(item.createdAt) ||
        !Number.isSafeInteger(item.reservedUsdCents) || item.reservedUsdCents < 0) {
      throw new BudgetError('budget-invalid-ledger', 'Invalid inference budget reservation');
    }
    keys.add(item.key);
    if (item.status === 'settled') {
      if (!Number.isSafeInteger(item.settledUsdCents) || item.settledUsdCents < 0 ||
          item.settledUsdCents > item.reservedUsdCents || typeof item.settlementKey !== 'string' ||
          typeof item.source !== 'string') {
        throw new BudgetError('budget-invalid-ledger', 'Invalid inference budget settlement');
      }
      settled += item.settledUsdCents;
    }
    if (item.status === 'reserved') reserved += item.reservedUsdCents;
    if (item.status === 'unresolved' && typeof item.reason !== 'string') {
      throw new BudgetError('budget-invalid-ledger', 'Invalid unresolved inference budget reservation');
    }
    if (item.status === 'unresolved') unresolved += item.reservedUsdCents;
  }
  if (settled !== budget.cumulativeSpendUsdCents || reserved !== budget.reservedUsdCents ||
      unresolved !== budget.unresolvedUsdCents) {
    throw new BudgetError('budget-invalid-ledger', 'Cumulative inference spend does not match settled reservations');
  }
  return budget;
}

export function budgetVisibility(budget, config) {
  assertBudgetLedger(budget);
  const { cumulativeCapUsdCents } = validateTrustedBudget(config);
  return {
    cumulativeCapUsdCents,
    cumulativeSpendUsdCents: budget.cumulativeSpendUsdCents,
    reservedUsdCents: budget.reservedUsdCents,
    unresolvedUsdCents: budget.unresolvedUsdCents,
    availableUsdCents: cumulativeCapUsdCents - budget.cumulativeSpendUsdCents -
      budget.reservedUsdCents - budget.unresolvedUsdCents,
  };
}

export function reserveInferenceBudget(state, config, { key, action, taskId, runId, reservedUsdCents, now }) {
  const { cumulativeCapUsdCents } = validateTrustedBudget(config);
  assertBudgetLedger(state.budget);
  if (!INFERENCE_ACTIONS.includes(action)) {
    throw new BudgetError('budget-invalid-action', 'Budget reservations are only valid for inference actions');
  }
  const existing = state.budget.reservations[key];
  if (existing) {
    if (existing.action !== action || existing.taskId !== taskId || existing.runId !== runId) {
      throw new BudgetError('budget-reservation-conflict', 'Inference budget reservation identity mismatch');
    }
    if (existing.status !== 'reserved') {
      throw new BudgetError('budget-reservation-unavailable', 'Inference budget reservation is not available for dispatch');
    }
    return existing;
  }
  if (!Number.isSafeInteger(reservedUsdCents) || reservedUsdCents < 0) {
    throw new BudgetError('budget-cost-bound-unavailable',
      'No trustworthy per-inference cost upper bound is available; refusing billable inference');
  }
  if (reservedUsdCents > cumulativeCapUsdCents - state.budget.cumulativeSpendUsdCents -
      state.budget.reservedUsdCents - state.budget.unresolvedUsdCents) {
    throw new BudgetError('budget-exhausted', 'Cumulative inference spending cap is exhausted');
  }
  const reservation = { key, action, taskId, runId, reservedUsdCents, status: 'reserved', createdAt: now };
  state.budget.reservations[key] = reservation;
  state.budget.reservedUsdCents += reservedUsdCents;
  return reservation;
}

export function settleInferenceBudget(state, key, settlement, now) {
  assertBudgetLedger(state.budget);
  const reservation = state.budget.reservations[key];
  if (!reservation) throw new BudgetError('budget-missing-reservation', 'Missing inference budget reservation');
  const valid = settlement && Number.isSafeInteger(settlement.costUsdCents) && settlement.costUsdCents >= 0 &&
    settlement.costUsdCents <= reservation.reservedUsdCents &&
    typeof settlement.settlementKey === 'string' && settlement.settlementKey.length > 0 &&
    typeof settlement.source === 'string' && settlement.source.length > 0;
  if (reservation.status === 'settled') {
    if (!valid || settlement.settlementKey !== reservation.settlementKey ||
        settlement.costUsdCents !== reservation.settledUsdCents || settlement.source !== reservation.source) {
      throw new BudgetError('budget-settlement-conflict', 'Inference budget settlement identity mismatch');
    }
    return reservation;
  }
  if (!valid) {
    reservation.status = 'unresolved';
    reservation.reason = 'missing-trustworthy-cost';
    reservation.updatedAt = now;
    state.budget.reservedUsdCents -= reservation.reservedUsdCents;
    state.budget.unresolvedUsdCents += reservation.reservedUsdCents;
    throw new BudgetError('budget-settlement-unavailable',
      'No trustworthy inference usage/cost settlement is available; reservation remains unresolved');
  }
  reservation.status = 'settled';
  reservation.settledUsdCents = settlement.costUsdCents;
  reservation.settlementKey = settlement.settlementKey;
  reservation.source = settlement.source;
  reservation.settledAt = now;
  state.budget.reservedUsdCents -= reservation.reservedUsdCents;
  state.budget.cumulativeSpendUsdCents += settlement.costUsdCents;
  assertBudgetLedger(state.budget);
  return reservation;
}
