import { CLI_VERSION, PolicyError, requirePolicy } from './model-policy.mjs';

// Bounded, contract-driven exporter parsing. The record/field names, their types
// and the provenance of every value must come from an owner-verified, evidence-backed
// contract in the reviewed catalog. Nothing here asserts that any particular schema
// is the supported one; without a verified contract every result stays rejected.
export const MAX_TELEMETRY_LINES = 10000;
export const MAX_TELEMETRY_LINE_BYTES = 64 * 1024;
export const RESPONSE_MODEL_PROVENANCE = Object.freeze(['backend-observed']);
export const EFFORT_PROVENANCE = Object.freeze(['unavailable', 'backend-observed']);
export const CORRELATION_BINDINGS = Object.freeze(['explicit-request-id', 'per-invocation-exporter-file']);
// Measurement units only. Documented CLI attributes report tokens, nano AI units
// and premium-request counts; `github.copilot.cost` is documented as a per-request
// model multiplier and explicitly "not a currency value", so it is never a unit here.
export const USAGE_UNITS = Object.freeze(['tokens', 'nano-aiu', 'premium-requests', 'ai-credits']);
export const USAGE_SCOPES = Object.freeze(['root-invocation', 'per-request']);

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function fieldPath(value, name) {
  requirePolicy(Array.isArray(value) && value.length > 0 && value.length <= 8 &&
    value.every(segment => text(segment) && segment.length <= 128 &&
      SEGMENT.test(segment) && !RESERVED.has(segment)),
  'TELEMETRY_SCHEMA_UNVERIFIED', `${name} must be a verified bounded field path of safe record keys`);
  return Object.freeze([...value]);
}

function lookup(record, path) {
  let current = record;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) ||
        !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

export function assertTelemetryContract(contract, { evidenceIds = new Set(), cliVersion = CLI_VERSION } = {}) {
  requirePolicy(contract && typeof contract === 'object' && !Array.isArray(contract),
    'TELEMETRY_SCHEMA_UNVERIFIED',
    'No owner-verified exporter contract is bound to the reviewed catalog; no inference result can be accepted');
  requirePolicy(contract.schemaVersion === 1 && contract.verified === true &&
    contract.method === 'manual-authenticated-cli' && text(contract.id),
  'TELEMETRY_SCHEMA_UNVERIFIED',
  'The exporter contract must be an identified, manually verified authenticated-CLI capture');
  requirePolicy(contract.cli?.package === '@github/copilot' && contract.cli?.version === cliVersion,
    'CLI_PIN_MISMATCH', `The exporter contract must cover @github/copilot@${cliVersion}`);
  requirePolicy(contract.exporter?.type === 'file' && contract.exporter?.format === 'json-lines',
    'TELEMETRY_SCHEMA_UNVERIFIED',
    'Only a verified file exporter emitting one JSON object per line is supported; OTLP JSON must not be assumed');
  const typePath = fieldPath(contract.records?.typePath, 'records.typePath');
  const statusPath = fieldPath(contract.records?.statusPath, 'records.statusPath');
  requirePolicy(text(contract.records?.inferenceType) && text(contract.records?.completedStatus),
    'TELEMETRY_SCHEMA_UNVERIFIED',
    'The contract must name the inference record type and the status value that marks a completed call');
  const fields = {
    requestModel: fieldPath(contract.fields?.requestModel, 'fields.requestModel'),
    responseModel: fieldPath(contract.fields?.responseModel, 'fields.responseModel'),
    correlationId: fieldPath(contract.fields?.correlationId, 'fields.correlationId')
  };
  requirePolicy(RESPONSE_MODEL_PROVENANCE.includes(contract.provenance?.responseModel),
    'TELEMETRY_PROVENANCE_UNVERIFIED',
    'The response-model value must be verified as backend-observed; requested flags, config echoes, help strings and a field labelled "resolved model" are not provenance');
  requirePolicy(contract.provenance?.fallback === 'reported-as-response-model',
    'TELEMETRY_PROVENANCE_UNVERIFIED',
    'Verified fallback reporting is required so an unapproved substituted model cannot be recorded as the requested one');
  requirePolicy(EFFORT_PROVENANCE.includes(contract.provenance?.responseEffort),
    'TELEMETRY_PROVENANCE_UNVERIFIED',
    'Backend reasoning-effort provenance must be explicitly verified or explicitly unavailable');
  if (contract.provenance.responseEffort === 'backend-observed') {
    fields.responseEffort = fieldPath(contract.fields?.responseEffort, 'fields.responseEffort');
  }
  requirePolicy(CORRELATION_BINDINGS.includes(contract.correlation?.binding),
    'TELEMETRY_SCHEMA_UNVERIFIED', 'A verified per-call correlation binding is required');
  let usage = null;
  if (contract.usage !== undefined && contract.usage !== null) {
    requirePolicy(USAGE_UNITS.includes(contract.usage.unit) && typeof contract.usage.cumulative === 'boolean' &&
      USAGE_SCOPES.includes(contract.usage.scope),
    'TELEMETRY_SCHEMA_UNVERIFIED',
    'Usage records must declare a verified unit, scope and whether counters are cumulative');
    usage = {
      unit: contract.usage.unit,
      scope: contract.usage.scope,
      cumulative: contract.usage.cumulative,
      recordIdPath: fieldPath(contract.usage.recordIdPath, 'usage.recordIdPath'),
      amountPath: fieldPath(contract.usage.amountPath, 'usage.amountPath')
    };
  }
  requirePolicy(Array.isArray(contract.evidence) && contract.evidence.length > 0 &&
    contract.evidence.every(id => text(id) && evidenceIds.has(id)),
  'MISSING_EVIDENCE', 'The exporter contract must reference reviewed catalog evidence');
  return Object.freeze({
    id: contract.id,
    records: Object.freeze({
      typePath, statusPath,
      inferenceType: contract.records.inferenceType,
      completedStatus: contract.records.completedStatus
    }),
    fields: Object.freeze(fields),
    provenance: Object.freeze({ ...contract.provenance }),
    correlation: Object.freeze({ binding: contract.correlation.binding }),
    usage: usage && Object.freeze(usage),
    evidence: Object.freeze([...contract.evidence])
  });
}

export function parseTelemetryRecords(raw) {
  requirePolicy(typeof raw === 'string' && raw.length > 0, 'MISSING_TELEMETRY',
    'No model-response telemetry; inference output is rejected');
  requirePolicy(!raw.includes('\u0000') && !raw.startsWith('\uFEFF'), 'INVALID_TELEMETRY',
    'Telemetry must not contain NUL bytes or a byte-order mark');
  requirePolicy(raw.endsWith('\n'), 'INVALID_TELEMETRY',
    'Telemetry must be complete JSON lines; a truncated final record is rejected');
  const lines = raw.slice(0, -1).split('\n');
  requirePolicy(lines.length <= MAX_TELEMETRY_LINES, 'TELEMETRY_LIMIT', 'Telemetry record count exceeded the safety limit');
  return lines.map(line => {
    const content = line.endsWith('\r') ? line.slice(0, -1) : line;
    requirePolicy(content.length > 0, 'INVALID_TELEMETRY', 'Telemetry must not contain blank records');
    requirePolicy(Buffer.byteLength(content) <= MAX_TELEMETRY_LINE_BYTES, 'TELEMETRY_LIMIT',
      'A telemetry record exceeded the safety limit');
    let record;
    try {
      record = JSON.parse(content);
    } catch {
      throw new PolicyError('INVALID_TELEMETRY', 'Telemetry records must be strict JSON objects');
    }
    requirePolicy(record && typeof record === 'object' && !Array.isArray(record), 'INVALID_TELEMETRY',
      'Telemetry records must be strict JSON objects');
    return record;
  });
}

function summarizeUsage(contract, records) {
  if (!contract.usage) return null;
  const amounts = new Map();
  for (const record of records) {
    const id = lookup(record, contract.usage.recordIdPath);
    const amount = lookup(record, contract.usage.amountPath);
    requirePolicy(text(id) && id.length <= 200, 'TELEMETRY_USAGE_UNVERIFIED',
      'Every usage record needs a verified record identity for duplicate-safe accounting');
    requirePolicy(Number.isSafeInteger(amount) && amount >= 0, 'TELEMETRY_USAGE_UNVERIFIED',
      'Usage amounts must be nonnegative safe integers in the verified unit');
    const previous = amounts.get(id);
    if (previous === undefined) amounts.set(id, amount);
    else if (contract.usage.cumulative) amounts.set(id, Math.max(previous, amount));
    else {
      requirePolicy(previous === amount, 'TELEMETRY_DUPLICATE_USAGE',
        'Conflicting duplicate usage records cannot be accounted without double counting');
    }
  }
  // Root-scoped counters are also stamped on child records, so summing them would
  // double count; exactly one root-scoped usage record may be accounted.
  requirePolicy(contract.usage.scope === 'per-request' || amounts.size === 1, 'TELEMETRY_DUPLICATE_USAGE',
    'Root-scoped usage must appear exactly once; summing repeated snapshots would double count');
  let total = 0;
  for (const amount of amounts.values()) total += amount;
  requirePolicy(Number.isSafeInteger(total), 'TELEMETRY_USAGE_UNVERIFIED', 'Usage total is not representable');
  // Token counts, premium requests, credits and USD are distinct units; conversion
  // to money is the cost source's responsibility, never an assumption made here.
  return Object.freeze({
    unit: contract.usage.unit, scope: contract.usage.scope,
    cumulative: contract.usage.cumulative, amount: total, records: amounts.size
  });
}

export function verifyTelemetry(raw, resolved, context = {}) {
  const contract = assertTelemetryContract(context.contract, {
    evidenceIds: context.evidenceIds instanceof Set ? context.evidenceIds : new Set(context.evidenceIds ?? [])
  });
  requirePolicy(resolved?.modelId && resolved.effort && Array.isArray(resolved.responseModelIds) &&
    resolved.responseModelIds.length > 0, 'PIN_REQUIRED',
  'A pinned model with verified backend response identities is required before any telemetry is accepted');
  const records = parseTelemetryRecords(raw);
  const inference = records.filter(record =>
    lookup(record, contract.records.typePath) === contract.records.inferenceType);
  requirePolicy(inference.length > 0, 'MISSING_TELEMETRY',
    'No inference record was exported for this call; the result is rejected');
  const correlations = new Set();
  const responses = new Set();
  for (const record of inference) {
    requirePolicy(lookup(record, contract.records.statusPath) === contract.records.completedStatus,
      'TELEMETRY_INCOMPLETE', 'Partial or failed inference records cannot produce accepted evidence');
    const correlationId = lookup(record, contract.fields.correlationId);
    requirePolicy(text(correlationId) && correlationId.length <= 200, 'TELEMETRY_UNCORRELATED',
      'Every inference record must carry its verified correlation identity');
    correlations.add(correlationId);
    const requestModel = lookup(record, contract.fields.requestModel);
    requirePolicy(requestModel === resolved.modelId, 'TELEMETRY_REQUEST_MISMATCH',
      'The exported requested model does not match the pinned resolution');
    const responseModel = lookup(record, contract.fields.responseModel);
    requirePolicy(text(responseModel) && resolved.responseModelIds.includes(responseModel),
      'UNAPPROVED_RESPONSE_MODEL',
      'The backend-observed response model is missing or is not an approved identity for the pinned model');
    responses.add(responseModel);
  }
  requirePolicy(correlations.size === 1 && responses.size === 1, 'TELEMETRY_MIXED_CALLS',
    'Telemetry mixes several calls or response models; mixed evidence cannot be attributed to this call');
  const [correlationId] = correlations;
  if (contract.correlation.binding === 'explicit-request-id') {
    requirePolicy(text(context.correlationId) && context.correlationId === correlationId,
      'TELEMETRY_UNCORRELATED', 'Telemetry does not correlate with this invocation');
  }
  let observedEffort = 'unavailable';
  if (contract.provenance.responseEffort === 'backend-observed') {
    const efforts = new Set(inference.map(record => lookup(record, contract.fields.responseEffort)));
    requirePolicy(efforts.size === 1 && efforts.has(resolved.effort), 'EFFORT_MISMATCH',
      'The backend-observed reasoning effort does not match the requested effort');
    observedEffort = resolved.effort;
  } else {
    requirePolicy(context.requireBackendEffort !== true, 'REASONING_UNVERIFIABLE',
      'Backend reasoning-effort verification is required by policy but is not exposed by the verified contract');
  }
  return Object.freeze({
    contractId: contract.id,
    recordCount: inference.length,
    correlationId,
    correlationBinding: contract.correlation.binding,
    requested: Object.freeze({ modelId: resolved.modelId, effort: resolved.effort }),
    observed: Object.freeze({
      modelId: [...responses][0],
      modelProvenance: contract.provenance.responseModel,
      effort: observedEffort,
      effortProvenance: contract.provenance.responseEffort
    }),
    usage: summarizeUsage(contract, inference)
  });
}
