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
  if (!budget || Object.keys(budget).sort().join(',') !== 'cumulativeCapUsdCents' ||
      !Number.isSafeInteger(budget.cumulativeCapUsdCents) || budget.cumulativeCapUsdCents < 0) {
    throw new BudgetError('budget-invalid-config',
      'trusted config must define inferenceBudget.cumulativeCapUsdCents as nonnegative integer USD cents');
  }
  return { cumulativeCapUsdCents: budget.cumulativeCapUsdCents };
}

export function createBudgetLedger() {
  return { schemaVersion: 1, cumulativeSpendUsdCents: 0, reservations: [] };
}

export function assertBudgetLedger(budget) {
  if (budget?.schemaVersion !== 1 || !Number.isSafeInteger(budget.cumulativeSpendUsdCents) ||
      budget.cumulativeSpendUsdCents < 0 || !Array.isArray(budget.reservations)) {
    throw new BudgetError('budget-invalid-ledger', 'Invalid inference budget accounting');
  }
  const keys = new Set();
  let settled = 0;
  for (const item of budget.reservations) {
    if (!item || typeof item.key !== 'string' || keys.has(item.key) || !STATUS.has(item.status) ||
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
    if (item.status === 'unresolved' && typeof item.reason !== 'string') {
      throw new BudgetError('budget-invalid-ledger', 'Invalid unresolved inference budget reservation');
    }
  }
  if (settled !== budget.cumulativeSpendUsdCents) {
    throw new BudgetError('budget-invalid-ledger', 'Cumulative inference spend does not match settled reservations');
  }
  return budget;
}

export function budgetVisibility(budget, config) {
  assertBudgetLedger(budget);
  const { cumulativeCapUsdCents } = validateTrustedBudget(config);
  const reservedUsdCents = budget.reservations
    .filter(item => item.status === 'reserved')
    .reduce((sum, item) => sum + item.reservedUsdCents, 0);
  const unresolvedUsdCents = budget.reservations
    .filter(item => item.status === 'unresolved')
    .reduce((sum, item) => sum + item.reservedUsdCents, 0);
  return {
    cumulativeCapUsdCents,
    cumulativeSpendUsdCents: budget.cumulativeSpendUsdCents,
    reservedUsdCents,
    unresolvedUsdCents,
    availableUsdCents: cumulativeCapUsdCents - budget.cumulativeSpendUsdCents - reservedUsdCents - unresolvedUsdCents,
  };
}

export function reserveInferenceBudget(state, config, { key, action, taskId, runId, reservedUsdCents, now }) {
  const { cumulativeCapUsdCents } = validateTrustedBudget(config);
  assertBudgetLedger(state.budget);
  if (!INFERENCE_ACTIONS.includes(action)) return null;
  const existing = state.budget.reservations.find(item => item.key === key);
  if (existing) {
    if (existing.action !== action || existing.taskId !== taskId || existing.runId !== runId) {
      throw new BudgetError('budget-reservation-conflict', 'Inference budget reservation identity mismatch');
    }
    return existing;
  }
  if (!Number.isSafeInteger(reservedUsdCents) || reservedUsdCents < 0) {
    throw new BudgetError('budget-cost-bound-unavailable',
      'No trustworthy per-inference cost upper bound is available; refusing billable inference');
  }
  const visibility = budgetVisibility(state.budget, config);
  if (reservedUsdCents > visibility.availableUsdCents) {
    throw new BudgetError('budget-exhausted', 'Cumulative inference spending cap is exhausted');
  }
  const reservation = { key, action, taskId, runId, reservedUsdCents, status: 'reserved', createdAt: now };
  state.budget.reservations.push(reservation);
  assertBudgetLedger(state.budget);
  if (state.budget.cumulativeSpendUsdCents > cumulativeCapUsdCents) {
    throw new BudgetError('budget-exhausted', 'Cumulative inference spend exceeds the configured cap');
  }
  return reservation;
}

export function settleInferenceBudget(state, key, settlement, now) {
  assertBudgetLedger(state.budget);
  const reservation = state.budget.reservations.find(item => item.key === key);
  if (!reservation) throw new BudgetError('budget-missing-reservation', 'Missing inference budget reservation');
  if (reservation.status === 'settled') {
    if ((settlement?.settlementKey && settlement.settlementKey !== reservation.settlementKey) ||
        (Number.isSafeInteger(settlement?.costUsdCents) && settlement.costUsdCents !== reservation.settledUsdCents) ||
        (settlement?.source && settlement.source !== reservation.source)) {
      throw new BudgetError('budget-settlement-conflict', 'Inference budget settlement identity mismatch');
    }
    return reservation;
  }
  const valid = settlement && Number.isSafeInteger(settlement.costUsdCents) && settlement.costUsdCents >= 0 &&
    settlement.costUsdCents <= reservation.reservedUsdCents &&
    typeof settlement.settlementKey === 'string' && settlement.settlementKey.length > 0 &&
    typeof settlement.source === 'string' && settlement.source.length > 0;
  if (!valid) {
    reservation.status = 'unresolved';
    reservation.reason = 'missing-trustworthy-cost';
    reservation.updatedAt = now;
    throw new BudgetError('budget-settlement-unavailable',
      'No trustworthy inference usage/cost settlement is available; reservation remains unresolved');
  }
  reservation.status = 'settled';
  reservation.settledUsdCents = settlement.costUsdCents;
  reservation.settlementKey = settlement.settlementKey;
  reservation.source = settlement.source;
  reservation.settledAt = now;
  state.budget.cumulativeSpendUsdCents += settlement.costUsdCents;
  assertBudgetLedger(state.budget);
  return reservation;
}
