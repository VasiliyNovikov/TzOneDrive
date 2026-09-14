import { BudgetError, INFERENCE_ACTIONS } from './budget.mjs';
import { CLI_VERSION } from './model-policy.mjs';

// Billable-usage units are not interchangeable: token counts, premium requests,
// credits and USD are distinct. Converting between them requires an owner-reviewed,
// evidence-backed rate; nothing here assumes, discovers or invents one.
// Official billing documentation states that 1 AI credit = USD 0.01. Token counts,
// nano AI units and the `github.copilot.cost` multiplier have no documented conversion
// to money, so they can never settle a reservation.
export const BILLABLE_UNITS = Object.freeze(['ai-credits', 'premium-requests', 'usd-cents']);

const text = value => typeof value === 'string' && value.trim().length > 0;

function reject(code, message) {
  throw new BudgetError(code, message);
}

export function assertInferenceCostSource(source, { cliVersion = CLI_VERSION } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    reject('budget-cost-source-unverified',
      'No owner-verified inference cost source is configured; billable inference is refused');
  }
  if (source.schemaVersion !== 1 || source.verified !== true || !text(source.id) ||
      source.method !== 'owner-reviewed-official-billing-documentation') {
    reject('budget-cost-source-unverified',
      'The inference cost source must be an identified, owner-reviewed official billing reference');
  }
  if (source.cli?.package !== '@github/copilot' || source.cli?.version !== cliVersion) {
    reject('budget-cost-source-unverified', `The cost source must cover @github/copilot@${cliVersion}`);
  }
  if (!BILLABLE_UNITS.includes(source.unit)) {
    reject('budget-cost-units-unconvertible',
      'The billable unit must be a verified AI-credit, premium-request or USD-cent unit; tokens, nano AI units and cost multipliers are not billing units');
  }
  if (!Number.isSafeInteger(source.usdCentsPerUnit) || source.usdCentsPerUnit <= 0 ||
      (source.unit !== 'premium-requests' && source.usdCentsPerUnit !== 1)) {
    reject('budget-cost-units-unconvertible',
      'A verified positive integer USD-cent rate per billable unit is required; rates must never be assumed');
  }
  const bound = source.preCallBound;
  if (!bound || bound.enforceable !== true || bound.includesHiddenRetries !== true ||
      !text(bound.mechanism) || !Number.isSafeInteger(bound.maxUnitsPerInvocation) ||
      bound.maxUnitsPerInvocation < 1) {
    reject('budget-cost-bound-unavailable',
      'No enforceable pre-call upper bound covering hidden retries and delegation is verified; post-call measurement cannot guarantee a cap');
  }
  const settlement = source.settlement;
  if (!settlement || settlement.available !== true || settlement.unit !== source.unit ||
      settlement.provenance !== 'backend-reported') {
    reject('budget-settlement-unavailable',
      'No backend-reported settlement in the same verified billable unit is available');
  }
  if (!Array.isArray(source.evidence) || source.evidence.length === 0 || !source.evidence.every(text)) {
    reject('budget-cost-source-unverified', 'The cost source must reference reviewed billing evidence');
  }
  return Object.freeze({
    id: source.id,
    unit: source.unit,
    usdCentsPerUnit: source.usdCentsPerUnit,
    maxUnitsPerInvocation: bound.maxUnitsPerInvocation,
    mechanism: bound.mechanism,
    evidence: Object.freeze([...source.evidence])
  });
}

export function preCallCostBound(source, { action } = {}) {
  const verified = assertInferenceCostSource(source);
  if (!INFERENCE_ACTIONS.includes(action)) {
    reject('budget-invalid-action', 'Budget reservations are only valid for inference actions');
  }
  const reservedUsdCents = verified.maxUnitsPerInvocation * verified.usdCentsPerUnit;
  if (!Number.isSafeInteger(reservedUsdCents)) {
    reject('budget-cost-bound-unavailable', 'The verified pre-call bound is not representable in USD cents');
  }
  return Object.freeze({
    reservedUsdCents, unit: verified.unit,
    maxUnits: verified.maxUnitsPerInvocation, source: verified.id
  });
}

export function settleInferenceUsage(source, usage, { settlementKey } = {}) {
  const verified = assertInferenceCostSource(source);
  if (!text(settlementKey)) {
    reject('budget-settlement-unavailable', 'A stable settlement key is required for idempotent settlement');
  }
  if (!usage || typeof usage !== 'object') {
    reject('budget-settlement-unavailable',
      'No billable usage evidence was produced; the reservation cannot be settled');
  }
  if (usage.unit !== verified.unit) {
    reject('budget-cost-units-unconvertible',
      'Observed usage is not expressed in the verified billable unit; token, premium-request, credit and USD values are not interchangeable');
  }
  if (!Number.isSafeInteger(usage.amount) || usage.amount < 0) {
    reject('budget-settlement-unavailable', 'Observed billable usage is missing or not a nonnegative safe integer');
  }
  if (usage.amount > verified.maxUnitsPerInvocation) {
    reject('budget-cost-bound-exceeded',
      'Observed billable usage exceeded the verified pre-call upper bound; the bound is not enforceable and settlement is refused');
  }
  return Object.freeze({
    costUsdCents: usage.amount * verified.usdCentsPerUnit,
    settlementKey,
    source: verified.id
  });
}
