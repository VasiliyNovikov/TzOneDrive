import { createHash, randomUUID } from 'node:crypto';

export const CLI_VERSION = '1.0.83';
export const ROLES = Object.freeze(['planning', 'implementation', 'repair', 'review', 'visual']);
export const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export class PolicyError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PolicyError';
    this.code = code;
  }
}

export function requirePolicy(condition, code, message) {
  if (!condition) throw new PolicyError(code, message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
    ? value : JSON.stringify(canonical(value))).digest('hex');
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function timestamp(value, name) {
  requirePolicy(text(value) && Number.isFinite(Date.parse(value)), 'INVALID_TIME', `${name} must be an ISO timestamp`);
  return Date.parse(value);
}

function clock(now) {
  const result = now === undefined ? Date.now() : new Date(now).getTime();
  requirePolicy(Number.isFinite(result), 'INVALID_TIME', 'Invalid current time');
  return result;
}

function exactId(id) {
  return text(id) && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id) &&
    !/(^|[-_/.])(auto|latest)([-_/.]|$)/i.test(id);
}

function references(refs, evidence, description) {
  requirePolicy(Array.isArray(refs) && refs.length > 0 &&
    refs.every(ref => text(ref) && evidence.has(ref)), 'MISSING_EVIDENCE', `${description} needs reviewed evidence references`);
}

function validateCatalog(policy, catalog, now) {
  requirePolicy(catalog?.schemaVersion === 1, 'CATALOG_REQUIRED', 'A reviewed authenticated model catalog is required');
  requirePolicy(catalog.cli?.package === '@github/copilot' && catalog.cli?.version === CLI_VERSION,
    'CLI_PIN_MISMATCH', 'Catalog must cover @github/copilot@1.0.83');
  const captured = timestamp(catalog.capturedAt, 'catalog.capturedAt');
  const expires = timestamp(catalog.expiresAt, 'catalog.expiresAt');
  requirePolicy(captured <= now && expires > now && expires > captured &&
    expires - captured <= policy.maxCatalogAgeSeconds * 1000 &&
    now - captured <= policy.maxCatalogAgeSeconds * 1000,
  'CATALOG_EXPIRED', 'Catalog is stale, future-dated, or exceeds the policy lifetime');
  const review = catalog.review;
  requirePolicy(review?.approved === true && review.method === 'manual-authenticated-cli' &&
    text(review.reviewer) && text(review.notes), 'CATALOG_NOT_REVIEWED',
  'Catalog requires explicit human sign-off after authenticated CLI inspection');
  const reviewed = timestamp(review.reviewedAt, 'review.reviewedAt');
  requirePolicy(reviewed >= captured && reviewed <= now, 'CATALOG_NOT_REVIEWED', 'Invalid review time');
  requirePolicy(Array.isArray(review.evidence) && review.evidence.length > 0,
    'MISSING_EVIDENCE', 'Catalog must reference locally retained evidence');
  const evidence = new Set();
  for (const item of review.evidence) {
    requirePolicy(text(item.id) && !evidence.has(item.id) && text(item.path) &&
      /^[a-f0-9]{64}$/.test(item.sha256) && text(item.source),
    'MISSING_EVIDENCE', 'Each unique evidence entry needs an id, path, SHA-256 and source');
    evidence.add(item.id);
  }
  const auth = catalog.authentication;
  requirePolicy(auth?.type === 'fine-grained-pat' && auth.repositoryAccess === 'none' &&
    text(auth.account) && /^[a-f0-9]{64}$/.test(auth.tokenSha256) &&
    JSON.stringify(canonical(auth.permissions)) === JSON.stringify({ copilot_requests: 'write' }),
  'AUTH_SCOPE', 'Use a dedicated fine-grained PAT with only Copilot Requests; no repository permissions or App token');
  references(auth.evidence, evidence, 'Authentication');
  const authExpires = timestamp(auth.expiresAt, 'authentication.expiresAt');
  requirePolicy(authExpires > now, 'AUTH_EXPIRED', 'Authentication sign-off has expired');
  requirePolicy(Array.isArray(catalog.models) && catalog.models.length > 0, 'CATALOG_REQUIRED', 'Catalog has no models');
  const ids = new Set();
  for (const model of catalog.models) {
    requirePolicy(exactId(model.id) && !ids.has(model.id), 'INVALID_MODEL_ID', 'Model IDs must be unique exact IDs, never auto/latest');
    ids.add(model.id);
  }
  return { evidence, expires: Math.min(expires, authExpires) };
}

export function resolvePolicy(policy, catalog, options = {}) {
  const now = clock(options.now);
  requirePolicy(policy?.schemaVersion === 1 &&
    policy.cli?.package === '@github/copilot' && policy.cli.version === CLI_VERSION,
  'CLI_PIN_MISMATCH', 'Policy must pin @github/copilot@1.0.83');
  requirePolicy(Number.isInteger(policy.maxCatalogAgeSeconds) && policy.maxCatalogAgeSeconds > 0 &&
    policy.maxCatalogAgeSeconds <= 86400 && Number.isInteger(policy.maxRunAgeSeconds) &&
    policy.maxRunAgeSeconds > 0 && policy.maxRunAgeSeconds <= 3600,
  'INVALID_LIFETIME', 'Catalog lifetime cannot exceed 24 hours; run lifetime cannot exceed one hour');
  requirePolicy(typeof policy.requireBackendEffort === 'boolean', 'INVALID_POLICY', 'Reasoning verification requirement must be explicit');
  const { evidence, expires } = validateCatalog(policy, catalog, now);
  const requestedRoles = options.roles ?? ROLES;
  requirePolicy(Array.isArray(requestedRoles) && requestedRoles.length > 0 &&
    new Set(requestedRoles).size === requestedRoles.length && requestedRoles.every(role => ROLES.includes(role)),
  'INVALID_ROLE', 'Select known, unique roles');
  const runId = options.runId ?? randomUUID();
  requirePolicy(text(runId) && /^[a-zA-Z0-9_-]{1,100}$/.test(runId), 'INVALID_RUN_ID', 'Run ID must be a simple identifier');
  const resolved = {};
  for (const role of requestedRoles) {
    const spec = policy.roles?.[role];
    requirePolicy(spec && text(spec.desiredDisplayName), role === 'visual' ? 'VISUAL_APPROVAL_REQUIRED' : 'INVALID_POLICY',
      `${role} must be explicitly configured${role === 'visual' ? ' and owner-approved' : ''}`);
    const desired = role === 'review' ? 'Claude Opus 5' : 'GPT-6 Astra';
    requirePolicy(role === 'visual' || spec.desiredDisplayName === desired, 'MODEL_DOWNGRADE',
      `${role} requires ${desired}; automatic substitutions are forbidden`);
    requirePolicy(spec.flagship === true && spec.effort === 'highest-supported', 'MODEL_DOWNGRADE',
      `${role} requires a flagship at its highest verified supported effort`);
    requirePolicy(spec.modelId === null || exactId(spec.modelId), 'INVALID_MODEL_ID', 'Use an exact verified ID or null while unvalidated');
    const matches = catalog.models.filter(model => model.displayName === spec.desiredDisplayName &&
      (spec.modelId === null || spec.modelId === model.id));
    requirePolicy(matches.length === 1, 'MODEL_UNAVAILABLE', `${role}: desired model is missing or ambiguous in the authenticated catalog`);
    const model = matches[0];
    requirePolicy(model.available === true && model.flagship === true, 'MODEL_UNAVAILABLE', `${role}: desired flagship is unavailable`);
    references(model.availabilityEvidence, evidence, `${role} availability`);
    references(model.effortEvidence, evidence, `${role} effort support`);
    references(model.modalityEvidence, evidence, `${role} input modalities`);
    requirePolicy(model.effortsComplete === true && Array.isArray(model.supportedEfforts) &&
      model.supportedEfforts.length > 0 && new Set(model.supportedEfforts).size === model.supportedEfforts.length &&
      model.supportedEfforts.every(effort => EFFORTS.includes(effort)),
    'UNKNOWN_EFFORT', `${role}: a complete verified supported-effort list is required`);
    requirePolicy(Array.isArray(model.inputModalities) && model.inputModalities.includes('text'),
      'UNKNOWN_MODALITY', `${role}: text-input support must be verified`);
    requirePolicy(Array.isArray(model.responseModelIds) && model.responseModelIds.length > 0 &&
      new Set(model.responseModelIds).size === model.responseModelIds.length &&
      model.responseModelIds.every(id => exactId(id) &&
        !catalog.models.some(other => other.id !== model.id && other.id === id)),
    'UNKNOWN_RESPONSE_MODEL', `${role}: verified backend response identities cannot include another catalog model`);
    references(model.responseModelEvidence, evidence, `${role} backend model identities`);
    if (role === 'visual') {
      const approval = spec.ownerApproval;
      requirePolicy(spec.modelId === model.id && approval?.approved === true &&
        approval.modelId === model.id && text(approval.owner) &&
        timestamp(approval.approvedAt, 'visual.ownerApproval.approvedAt') <= now,
      'VISUAL_APPROVAL_REQUIRED', 'Visual model requires explicit dated owner approval for this exact model ID');
      references(approval.evidence, evidence, 'Visual owner approval');
      requirePolicy(model.inputModalities.includes('image'), 'UNKNOWN_MODALITY', 'Visual role requires verified native image input');
    }
    const effort = EFFORTS.filter(level => model.supportedEfforts.includes(level)).at(-1);
    resolved[role] = {
      desiredDisplayName: spec.desiredDisplayName,
      modelId: model.id,
      effort,
      responseModelIds: [...model.responseModelIds],
      inputModalities: [...model.inputModalities]
    };
  }
  const snapshot = {
    schemaVersion: 1,
    cliVersion: CLI_VERSION,
    runId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(expires, now + policy.maxRunAgeSeconds * 1000)).toISOString(),
    policyHash: digest(policy),
    catalogHash: digest(catalog),
    requireBackendEffort: policy.requireBackendEffort,
    roles: resolved
  };
  return freeze({ ...snapshot, snapshotHash: digest(snapshot) });
}

export function assertPinnedResolution(resolution, policy, catalog, options = {}) {
  requirePolicy(resolution?.schemaVersion === 1 && resolution.roles &&
    resolution.policyHash === digest(policy) && resolution.catalogHash === digest(catalog),
  'PIN_CHANGED', 'Policy/catalog changed; stop this run and obtain a new preflight snapshot');
  const now = clock(options.now);
  requirePolicy(timestamp(resolution.issuedAt, 'resolution.issuedAt') <= now &&
    timestamp(resolution.expiresAt, 'resolution.expiresAt') > now,
  'PIN_EXPIRED', 'Run snapshot is expired or future-dated');
  const expected = resolvePolicy(policy, catalog, {
    now: resolution.issuedAt,
    runId: resolution.runId,
    roles: Object.keys(resolution.roles)
  });
  requirePolicy(digest(expected) === digest(resolution), 'PIN_CHANGED', 'Resolved run snapshot has been modified');
  return expected;
}
