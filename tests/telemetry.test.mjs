import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  USAGE_UNITS, assertTelemetryContract, parseTelemetryRecords, verifyTelemetry
} from '../factory/telemetry.mjs';

const shippedCatalog = JSON.parse(await readFile(new URL('../factory/model-catalog.json', import.meta.url), 'utf8'));

const code = expected => error => error.code === expected;

// SYNTHETIC TEST SCAFFOLDING ONLY. The contract and records below are invented for
// offline control-flow tests. They are not an authenticated capture of any CLI
// release and must never be imported into a reviewed catalog as evidence.
function contract(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'synthetic-unit-test-contract',
    verified: true,
    method: 'manual-authenticated-cli',
    cli: { package: '@github/copilot', version: '1.0.83' },
    exporter: { type: 'file', format: 'json-lines' },
    records: { typePath: ['name'], inferenceType: 'chat', statusPath: ['status'], completedStatus: 'ok' },
    fields: {
      requestModel: ['attributes', 'gen_ai.request.model'],
      responseModel: ['attributes', 'gen_ai.response.model'],
      correlationId: ['attributes', 'github.copilot.interaction_id'],
      responseEffort: ['attributes', 'gen_ai.request.reasoning.level']
    },
    provenance: {
      responseModel: 'backend-observed',
      responseEffort: 'unavailable',
      fallback: 'reported-as-response-model'
    },
    correlation: { binding: 'per-invocation-exporter-file' },
    usage: {
      unit: 'nano-aiu', scope: 'root-invocation', cumulative: false,
      recordIdPath: ['attributes', 'gen_ai.response.id'],
      amountPath: ['attributes', 'github.copilot.nano_aiu']
    },
    evidence: ['telemetry-capture'],
    ...overrides
  };
}

const resolved = Object.freeze({
  modelId: 'gpt-6-astra', effort: 'xhigh', responseModelIds: ['gpt-6-astra', 'gpt-6-astra-2026-09-01']
});

function record(overrides = {}, attributes = {}) {
  return {
    name: 'chat',
    status: 'ok',
    attributes: {
      'gen_ai.request.model': 'gpt-6-astra',
      'gen_ai.response.model': 'gpt-6-astra',
      'github.copilot.interaction_id': 'interaction-1',
      'gen_ai.response.id': 'response-1',
      'github.copilot.nano_aiu': 1500,
      ...attributes
    },
    ...overrides
  };
}

const lines = (...records) => `${records.map(item => JSON.stringify(item)).join('\n')}\n`;

function verify(raw, { contract: overrides, ...options } = {}) {
  return verifyTelemetry(raw, resolved, {
    contract: contract(overrides), evidenceIds: new Set(['telemetry-capture']), ...options
  });
}

test('shipped catalog carries no verified exporter contract, so every inference result stays rejected', () => {
  assert.equal(shippedCatalog.telemetryContract, undefined);
  assert.throws(() => verifyTelemetry(lines(record()), resolved, { contract: shippedCatalog.telemetryContract }),
    code('TELEMETRY_SCHEMA_UNVERIFIED'));
  assert.throws(() => verifyTelemetry('', resolved, {}), code('TELEMETRY_SCHEMA_UNVERIFIED'));
});

test('a verified contract accepts a correlated, approved, complete synthetic capture', () => {
  const audit = verify(lines(record()));
  assert.equal(audit.contractId, 'synthetic-unit-test-contract');
  assert.equal(audit.recordCount, 1);
  assert.equal(audit.correlationId, 'interaction-1');
  assert.deepEqual(audit.requested, { modelId: 'gpt-6-astra', effort: 'xhigh' });
  assert.equal(audit.observed.modelId, 'gpt-6-astra');
  assert.equal(audit.observed.modelProvenance, 'backend-observed');
  // Requested effort is never reported as an executed backend effort.
  assert.equal(audit.observed.effort, 'unavailable');
  assert.deepEqual(audit.usage, { unit: 'nano-aiu', scope: 'root-invocation', cumulative: false, amount: 1500, records: 1 });
});

test('unverified, unsigned, mismatched or unreferenced contracts cannot open the gate', () => {
  for (const [overrides, expected] of [
    [{ verified: false }, 'TELEMETRY_SCHEMA_UNVERIFIED'],
    [{ method: 'owner-attestation' }, 'TELEMETRY_SCHEMA_UNVERIFIED'],
    [{ id: '' }, 'TELEMETRY_SCHEMA_UNVERIFIED'],
    [{ cli: { package: '@github/copilot', version: '1.0.84' } }, 'CLI_PIN_MISMATCH'],
    [{ exporter: { type: 'otlp-http', format: 'json' } }, 'TELEMETRY_SCHEMA_UNVERIFIED'],
    [{ exporter: { type: 'file', format: 'otlp-json' } }, 'TELEMETRY_SCHEMA_UNVERIFIED'],
    [{ records: { typePath: ['name'], inferenceType: 'chat', statusPath: ['status'] } }, 'TELEMETRY_SCHEMA_UNVERIFIED'],
    [{ fields: { requestModel: ['__proto__'], responseModel: ['a'], correlationId: ['b'] } }, 'TELEMETRY_SCHEMA_UNVERIFIED'],
    [{ correlation: { binding: 'assumed' } }, 'TELEMETRY_SCHEMA_UNVERIFIED'],
    [{ evidence: ['not-in-catalog'] }, 'MISSING_EVIDENCE'],
    [{ evidence: [] }, 'MISSING_EVIDENCE']
  ]) {
    assert.throws(() => verify(lines(record()), { contract: overrides }), code(expected));
  }
  assert.throws(() => assertTelemetryContract(null), code('TELEMETRY_SCHEMA_UNVERIFIED'));
});

test('requested echoes, "resolved model" labels and unreported fallback are not backend provenance', () => {
  for (const provenance of [
    { responseModel: 'requested-echo', responseEffort: 'unavailable', fallback: 'reported-as-response-model' },
    { responseModel: 'resolved-model-label', responseEffort: 'unavailable', fallback: 'reported-as-response-model' },
    { responseModel: 'backend-observed', responseEffort: 'unavailable', fallback: 'unknown' },
    { responseModel: 'backend-observed', responseEffort: 'assumed', fallback: 'reported-as-response-model' }
  ]) {
    assert.throws(() => verify(lines(record()), { contract: { provenance } }), code('TELEMETRY_PROVENANCE_UNVERIFIED'));
  }
});

test('malformed, truncated, blank, oversized and non-object records are rejected', () => {
  assert.throws(() => parseTelemetryRecords(''), code('MISSING_TELEMETRY'));
  assert.throws(() => parseTelemetryRecords('{"name":"chat"}'), code('INVALID_TELEMETRY'));
  assert.throws(() => parseTelemetryRecords('\uFEFF{"name":"chat"}\n'), code('INVALID_TELEMETRY'));
  assert.throws(() => parseTelemetryRecords('{"name":"chat"}\n\n'), code('INVALID_TELEMETRY'));
  assert.throws(() => parseTelemetryRecords('{"name":\n'), code('INVALID_TELEMETRY'));
  assert.throws(() => parseTelemetryRecords('[{"name":"chat"}]\n'), code('INVALID_TELEMETRY'));
  assert.throws(() => parseTelemetryRecords('"chat"\n'), code('INVALID_TELEMETRY'));
  assert.throws(() => parseTelemetryRecords(`${'{"name":"chat"}\n'.repeat(10001)}`), code('TELEMETRY_LIMIT'));
  assert.throws(() => parseTelemetryRecords(`${JSON.stringify({ name: 'x'.repeat(70000) })}\n`), code('TELEMETRY_LIMIT'));
  assert.equal(parseTelemetryRecords('{"name":"chat"}\r\n').length, 1);
});

test('missing, partial and failed inference records cannot become accepted evidence', () => {
  assert.throws(() => verify(lines(record({ name: 'execute_tool' }))), code('MISSING_TELEMETRY'));
  assert.throws(() => verify(lines(record({ status: 'error' }))), code('TELEMETRY_INCOMPLETE'));
  assert.throws(() => verify(lines(record(), record({ status: 'error' }))), code('TELEMETRY_INCOMPLETE'));
  assert.throws(() => verify(lines(record({ status: undefined }))), code('TELEMETRY_INCOMPLETE'));
});

test('uncorrelated and mixed-call telemetry is never attributed to this invocation', () => {
  assert.throws(() => verify(lines(record({}, { 'github.copilot.interaction_id': undefined }))),
    code('TELEMETRY_UNCORRELATED'));
  assert.throws(() => verify(lines(record(), record({}, {
    'github.copilot.interaction_id': 'interaction-2', 'gen_ai.response.id': 'response-2'
  }))), code('TELEMETRY_MIXED_CALLS'));
  assert.throws(() => verify(lines(record(), record({}, {
    'gen_ai.response.model': 'gpt-6-astra-2026-09-01', 'gen_ai.response.id': 'response-2'
  }))), code('TELEMETRY_MIXED_CALLS'));
  const explicit = { correlation: { binding: 'explicit-request-id' } };
  assert.throws(() => verify(lines(record()), { contract: explicit }), code('TELEMETRY_UNCORRELATED'));
  assert.throws(() => verify(lines(record()), { contract: explicit, correlationId: 'other' }),
    code('TELEMETRY_UNCORRELATED'));
  assert.equal(verify(lines(record()), { contract: explicit, correlationId: 'interaction-1' }).correlationId,
    'interaction-1');
});

test('unapproved response identities, silent fallback and request drift fail closed', () => {
  assert.throws(() => verify(lines(record({}, { 'gen_ai.response.model': 'gpt-5.4-mini' }))),
    code('UNAPPROVED_RESPONSE_MODEL'));
  assert.throws(() => verify(lines(record({}, { 'gen_ai.response.model': undefined }))),
    code('UNAPPROVED_RESPONSE_MODEL'));
  assert.throws(() => verify(lines(record({}, { 'gen_ai.request.model': 'claude-opus-5' }))),
    code('TELEMETRY_REQUEST_MISMATCH'));
  assert.throws(() => verifyTelemetry(lines(record()), { modelId: 'gpt-6-astra', effort: 'xhigh' },
    { contract: contract(), evidenceIds: new Set(['telemetry-capture']) }), code('PIN_REQUIRED'));
});

test('requested effort is never reported as executed backend effort', () => {
  assert.throws(() => verify(lines(record()), { requireBackendEffort: true }), code('REASONING_UNVERIFIABLE'));
  const observed = { provenance: { responseModel: 'backend-observed', responseEffort: 'backend-observed', fallback: 'reported-as-response-model' } };
  const audit = verify(lines(record({}, { 'gen_ai.request.reasoning.level': 'xhigh' })),
    { contract: observed, requireBackendEffort: true });
  assert.equal(audit.observed.effort, 'xhigh');
  assert.equal(audit.observed.effortProvenance, 'backend-observed');
  assert.throws(() => verify(lines(record({}, { 'gen_ai.request.reasoning.level': 'medium' })), { contract: observed }),
    code('EFFORT_MISMATCH'));
});

test('usage accounting rejects unknown amounts, double counting and conflicting duplicates', () => {
  // The documented per-request cost multiplier is not a usage or currency unit.
  assert.ok(!USAGE_UNITS.includes('github.copilot.cost'));
  assert.ok(!USAGE_UNITS.includes('usd-cents'));
  assert.throws(() => verify(lines(record({}, { 'github.copilot.nano_aiu': undefined }))),
    code('TELEMETRY_USAGE_UNVERIFIED'));
  assert.throws(() => verify(lines(record({}, { 'github.copilot.nano_aiu': -1 }))),
    code('TELEMETRY_USAGE_UNVERIFIED'));
  assert.throws(() => verify(lines(record({}, { 'github.copilot.nano_aiu': 1.5 }))),
    code('TELEMETRY_USAGE_UNVERIFIED'));
  assert.throws(() => verify(lines(record({}, { 'gen_ai.response.id': undefined }))),
    code('TELEMETRY_USAGE_UNVERIFIED'));
  // Root-scoped counters are stamped on child records; they must not be summed.
  assert.throws(() => verify(lines(record(), record({}, { 'gen_ai.response.id': 'response-2' }))),
    code('TELEMETRY_DUPLICATE_USAGE'));
  assert.throws(() => verify(lines(record(), record({}, { 'github.copilot.nano_aiu': 900 }))),
    code('TELEMETRY_DUPLICATE_USAGE'));
  assert.equal(verify(lines(record(), record())).usage.amount, 1500);
  const perRequest = { usage: { ...contract().usage, scope: 'per-request' } };
  assert.equal(verify(lines(record(), record({}, { 'gen_ai.response.id': 'response-2', 'github.copilot.nano_aiu': 500 })),
    { contract: perRequest }).usage.amount, 2000);
  const cumulative = { usage: { ...contract().usage, scope: 'per-request', cumulative: true } };
  assert.equal(verify(lines(record(), record({}, { 'github.copilot.nano_aiu': 2400 })),
    { contract: cumulative }).usage.amount, 2400);
});
