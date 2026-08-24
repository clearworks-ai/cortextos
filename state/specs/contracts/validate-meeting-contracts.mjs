#!/usr/bin/env node
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from './json-schema-subset-validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeTrustedAuthorityRootDigest = process.env.MEETING_AUTHORITY_ROOT_DIGEST ?? null;
const runtimeTrustedFirefliesVerificationConfigDigest = process.env.FIREFLIES_VERIFICATION_CONFIG_DIGEST ?? null;
const runtimeTrustedCoverageClockAuthorityDigest = process.env.COVERAGE_CLOCK_AUTHORITY_DIGEST ?? null;
const load = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jcs = (value) => Array.isArray(value)
  ? `[${value.map(jcs).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const unique = (items) => new Set(items).size === items.length;
const jsonSetEqual = (left, right) => left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
const CRM_ALLOWED_OPERATIONS = Object.freeze([
  'upsert_account',
  'upsert_contact',
  'upsert_engagement',
  'upsert_interaction',
  'upsert_lifecycle',
  'propose_account_change',
  'propose_contact_change',
  'propose_engagement_change',
  'propose_opportunity_change',
]);
const CRM_DURABLE_STATES = Object.freeze(['accepted_pending', 'applied', 'rejected', 'unknown_commit', 'terminal_failed']);
const exactOperationEntity = {
  upsert_account: 'account',
  upsert_contact: 'contact',
  upsert_engagement: 'engagement',
  upsert_interaction: 'interaction',
  upsert_lifecycle: 'lifecycle',
};
const validateExactOperationBinding = (value) => {
  const expectedEntity = exactOperationEntity[value.operation];
  if (!expectedEntity) return [];
  return value.requestKind === 'system_exact' && value.target?.entityType === expectedEntity
    ? []
    : ['CRM exact operation/target mismatch'];
};
const schemas = {
  record: load('meeting-record-v1.schema.json'),
  observation: load('meeting-observation-v1.schema.json'),
  firefliesVerificationConfig: load('fireflies-verification-config-v1.schema.json'),
  processingFailure: load('meeting-processing-failure-v1.schema.json'),
  preRecordIngressFailure: load('pre-record-ingress-failure-v1.schema.json'),
  delivery: load('meeting-delivery-envelope-v1.schema.json'),
  coverage: load('coverage-snapshot-v1.schema.json'),
  coverageClock: load('coverage-evaluation-clock-v1.schema.json'),
  coverageClockAuthority: load('coverage-clock-authority-v1.schema.json'),
  crmProjection: load('crm-projection-snapshot-v1.schema.json'),
  intentRequest: load('crm-write-intent-request-v1.schema.json'),
  intent: load('crm-write-intent-v1.schema.json'),
  writeSet: load('crm-write-set-v1.schema.json'),
  writeSetArtifacts: load('crm-write-set-artifacts-v1.schema.json'),
  identityOverride: load('identity-override-v1.schema.json'),
  authorityRegistry: load('claim-authority-registry-v1.schema.json'),
  authorityRoot: load('meeting-authority-root-v1.schema.json'),
  dispositionSet: load('claim-disposition-set-v1.schema.json'),
  replicationAck: load('projection-replication-ack-v1.schema.json'),
  briefsReadback: load('briefs-projection-readback-v1.schema.json'),
  briefsOutput: load('briefs-meeting-intelligence-output-v1.schema.json'),
  semanticEvaluation: load('semantic-evaluation-v1.schema.json'),
  semanticDataset: load('semantic-evaluation-dataset-v1.schema.json'),
};

function recordDigest(record) {
  const payload = clone(record);
  delete payload.recordDigest;
  return sha256(jcs(payload));
}

function digestWithout(value, field) {
  const payload = clone(value);
  delete payload[field];
  return sha256(jcs(payload));
}

const deliveryManifestDigest = (delivery) => digestWithout(delivery, 'manifestDigest');
const coverageSnapshotDigest = (coverage) => digestWithout(coverage, 'snapshotDigest');
const crmProjectionDigest = (projection) => digestWithout(projection, 'projectionDigest');
const crmIntentRequestDigest = (request) => digestWithout(request, 'requestDigest');
const crmIntentDigest = (intent) => digestWithout(intent, 'intentDigest');
const crmWriteSetDigest = (writeSet) => digestWithout(writeSet, 'writeSetDigest');
const firefliesVerificationConfigDigest = (config) => digestWithout(config, 'configDigest');
const reconciliationReceiptDigest = (receipt) => digestWithout(receipt, 'receiptDigest');
const attemptReceiptDigest = (receipt) => sha256(jcs(receipt));
const attemptReconciliationReceiptDigest = (receipt) => digestWithout(receipt, 'receiptDigest');
const attemptReconciliationOutcomeDigest = (receipt, reconciliation) => sha256(jcs({
  sink: receipt.sink,
  idempotencyKey: receipt.idempotencyKey,
  unknownStateDigest: reconciliation.unknownStateDigest,
  outcome: receipt.state,
  outcomeVersion: reconciliation.outcomeVersion,
  providerId: receipt.providerId ?? receipt.providerMessageId ?? null,
  readbackVersion: receipt.readbackVersion,
  readbackObjectDigest: receipt.readbackObjectDigest,
  readbackDigest: receipt.readbackDigest,
  errorCode: receipt.errorCode,
}));
const identityOverrideDigest = (override) => digestWithout(override, 'overrideDigest');
const authorityRegistryDigest = (registry) => digestWithout(registry, 'registryDigest');
const authorityRootDigest = (root) => digestWithout(root, 'rootDigest');
const dispositionSetDigest = (set) => digestWithout(set, 'dispositionSetDigest');
const candidateContentPayload = (claim) => ({
  claimId: claim.claimId,
  canonicalClaimId: claim.canonicalClaimId,
  supersedesClaimId: claim.supersedesClaimId,
  identityPolicyVersion: claim.identityPolicyVersion,
  identityBasisDigest: claim.identityBasisDigest,
  claimKind: claim.claimKind,
  semanticClass: claim.semanticClass,
  statement: claim.statement,
  ownerId: claim.ownerId,
  direction: claim.direction,
  workState: claim.workState,
  dependency: claim.dependency,
  due: claim.due,
  closure: claim.closure,
  evidenceRefs: [...claim.evidenceRefs].sort(),
  origin: claim.origin,
});
const candidateContentDigest = (claim) => sha256(jcs(candidateContentPayload(claim)));
const sinkReadbackDigest = (receipt) => sha256(jcs({ sink: receipt.sink, providerId: receipt.providerId, recordDigest: receipt.recordDigest, readbackVersion: receipt.readbackVersion, readbackObjectDigest: receipt.readbackObjectDigest }));
const paReadbackDigest = (receipt) => {
  const payload = { sink: receipt.sink, notificationKind: receipt.notificationKind, providerMessageId: receipt.providerMessageId, sourceKey: receipt.sourceKey, outboundDigest: receipt.outboundDigest, recordDigest: receipt.recordDigest, durablePath: receipt.durablePath, readbackVersion: receipt.readbackVersion, readbackObjectDigest: receipt.readbackObjectDigest };
  if (receipt.notificationKind === 'correction') Object.assign(payload, { predecessorReceiptDigest: receipt.predecessorReceiptDigest, predecessorSourceKey: receipt.predecessorSourceKey, predecessorProviderMessageId: receipt.predecessorProviderMessageId, correctsProviderMessageId: receipt.correctsProviderMessageId, consequentialDeltaDigest: receipt.consequentialDeltaDigest, correctionDeltaDigest: receipt.correctionDeltaDigest });
  return sha256(jcs(payload));
};
const consequentialDeltaDigest = (record) => sha256(jcs(record.semanticViews.consequentialDeltaClaimIds.map((canonicalClaimId) => {
  const claim = record.claims.find((item) => item.canonicalClaimId === canonicalClaimId || item.claimId === canonicalClaimId);
  return { canonicalClaimId: claim?.canonicalClaimId ?? canonicalClaimId, claimId: claim?.claimId ?? null, candidateContentDigest: claim?.candidateContentDigest ?? null };
}).sort((left, right) => left.canonicalClaimId.localeCompare(right.canonicalClaimId))));
const meetingRecordDeltaPayload = (previous, current) => {
  const prior = new Map(previous.claims.map((claim) => [claim.canonicalClaimId, claim]));
  const next = new Map(current.claims.map((claim) => [claim.canonicalClaimId, claim]));
  const ids = [...new Set([...prior.keys(), ...next.keys()])].sort();
  return {
    orgId: current.orgId, canonicalMeetingId: current.canonicalMeetingId,
    previousRecordVersion: previous.recordVersion, previousRecordDigest: previous.recordDigest,
    currentRecordVersion: current.recordVersion, currentRecordDigest: current.recordDigest,
    claimChanges: ids.filter((id) => prior.get(id)?.candidateContentDigest !== next.get(id)?.candidateContentDigest).map((canonicalClaimId) => ({ canonicalClaimId, previousContentDigest: prior.get(canonicalClaimId)?.candidateContentDigest ?? null, currentContentDigest: next.get(canonicalClaimId)?.candidateContentDigest ?? null })),
    lifecycleBefore: previous.lifecycle, lifecycleAfter: current.lifecycle,
    consequentialBefore: [...previous.semanticViews.consequentialDeltaClaimIds].sort(), consequentialAfter: [...current.semanticViews.consequentialDeltaClaimIds].sort(),
    crmConsequentialFields: ['relationshipChangeClaimIds', 'projectChangeClaimIds', 'dealChangeClaimIds', 'accountChangeClaimIds', 'opportunityClaimIds'].map((field) => ({ field, before: [...previous.semanticViews[field]].sort(), after: [...current.semanticViews[field]].sort() })),
  };
};
const meetingRecordDeltaDigest = (previous, current) => sha256(jcs(meetingRecordDeltaPayload(previous, current)));
const claimEvidenceLineage = (record, claim) => claim.evidenceRefs.map((evidenceId) => {
  const evidence = record.evidenceRegistry.find((item) => item.evidenceId === evidenceId);
  const source = record.sourceObservations.find((item) => item.sourceId === evidence?.sourceId);
  const artifact = record.artifacts.find((item) => item.artifactId === evidence?.artifactId);
  return {
    evidenceId,
    sourceId: evidence?.sourceId ?? null,
    sourceLineageDigest: source?.lineageDigest ?? null,
    transcriptDigest: source?.transcriptDigest ?? null,
    evidenceDigest: source?.evidenceDigest ?? null,
    artifactId: evidence?.artifactId ?? null,
    artifactDigest: artifact?.digest ?? null,
    artifactLineageDigest: artifact?.sourceLineageDigest ?? null,
    startMs: evidence?.startMs ?? null,
    endMs: evidence?.endMs ?? null,
    quoteDigest: evidence?.quoteDigest ?? null,
  };
}).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
const claimEvidenceLineageDigest = (record, claim) => sha256(jcs(claimEvidenceLineage(record, claim)));
const claimIdentityBasisDigest = (record, claim) => sha256(jcs({
  orgId: record.orgId,
  canonicalMeetingId: record.canonicalMeetingId,
  identityPolicyVersion: claim.identityPolicyVersion,
  canonicalClaimId: claim.canonicalClaimId,
  evidenceLineageDigest: claimEvidenceLineageDigest(record, claim),
}));
const claimDecisionDigest = (record, decision) => sha256(jcs({
  ...Object.fromEntries(Object.entries(decision).filter(([key]) => key !== 'decisionDigest')),
  orgId: record.orgId,
  canonicalMeetingId: record.canonicalMeetingId,
  recordVersion: record.recordVersion,
}));
const hmacHex = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
const constantTimeHexEqual = (left, right) => {
  if (!/^[0-9a-f]{64}$/.test(left ?? '') || !/^[0-9a-f]{64}$/.test(right ?? '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
};
const relayCanonicalPayload = (observation) => jcs({
  method: observation.relay.internalAuth.method,
  path: observation.relay.internalAuth.path,
  timestamp: observation.relay.internalAuth.timestamp,
  nonce: observation.relay.internalAuth.nonce,
  bodyDigest: observation.relay.internalAuth.bodyDigest,
  rawBodyDigest: observation.rawBodyDigest,
  orgId: observation.orgId,
  observationId: observation.observationId,
  provider: observation.provider,
  providerSourceId: observation.providerSourceId,
  idempotencyKey: observation.relay.idempotencyKey,
  intentDigest: observation.relay.intentDigest,
});
const replayReceiptPayload = (observation) => jcs({
  orgId: observation.orgId,
  keyId: observation.relay.internalAuth.keyId,
  nonce: observation.relay.internalAuth.nonce,
  canonicalRequestDigest: observation.relay.internalAuth.canonicalRequestDigest,
  storeId: observation.relay.replayReceipt.storeId,
  nonceKey: observation.relay.replayReceipt.nonceKey,
  decision: observation.relay.replayReceipt.decision,
  acceptedAt: observation.relay.replayReceipt.acceptedAt,
  expiresAt: observation.relay.replayReceipt.expiresAt,
});
const compareSourcePreference = (left, right) => {
  const available = (value) => value.transcriptState === 'available' ? 1 : 0;
  for (const getter of [available, (value) => value.evidenceArtifactCount, (value) => value.segmentCount, (value) => value.normalizedWordCount, (value) => value.durationSeconds]) {
    const delta = getter(right) - getter(left);
    if (delta) return delta;
  }
  const captured = Date.parse(left.capturedAt) - Date.parse(right.capturedAt);
  return captured || left.sourceId.localeCompare(right.sourceId);
};

function validateFirefliesVerificationConfig(config, trustedDigest = null) {
  if (!config) return ['Fireflies verification config missing'];
  const schemaErrors = validateJsonSchema(schemas.firefliesVerificationConfig, config);
  const errors = schemaErrors.length ? ['Fireflies verification config schema validation failed', ...schemaErrors.map((error) => `schema firefliesVerificationConfig ${error}`)] : [];
  if (firefliesVerificationConfigDigest(config) !== config.configDigest) errors.push('Fireflies verification config digest mismatch');
  if (!trustedDigest || config.configDigest !== trustedDigest) errors.push('Fireflies verification config not deployment trusted');
  const validFrom = Date.parse(config.validFrom), validUntil = Date.parse(config.validUntil);
  if (![validFrom, validUntil].every(Number.isFinite) || validUntil <= validFrom) errors.push('Fireflies verification config validity invalid');
  const keyIds = config.keys.map((key) => key.keyId);
  if (!unique(keyIds)) errors.push('Fireflies verification config duplicate key');
  const active = config.keys.find((key) => key.keyId === config.activeKeyId);
  if (!active || active.status !== 'active') errors.push('Fireflies verification active key invalid');
  for (const key of config.keys) {
    const keyFrom = Date.parse(key.validFrom), keyUntil = Date.parse(key.validUntil);
    if (![keyFrom, keyUntil].every(Number.isFinite) || keyFrom < validFrom || keyUntil > validUntil || keyUntil <= keyFrom) errors.push('Fireflies verification key validity invalid');
  }
  for (const field of ['previousKeyId', 'nextKeyId']) if (config.rotation[field] !== null && !keyIds.includes(config.rotation[field])) errors.push('Fireflies verification rotation key missing');
  const nextRotationAt = Date.parse(config.rotation.nextRotationAt);
  const overlapUntil = config.rotation.overlapUntil === null ? null : Date.parse(config.rotation.overlapUntil);
  if (!Number.isFinite(nextRotationAt) || nextRotationAt < validFrom || nextRotationAt > validUntil || (overlapUntil !== null && (!Number.isFinite(overlapUntil) || overlapUntil < nextRotationAt || overlapUntil > validUntil))) errors.push('Fireflies verification rotation window invalid');
  return [...new Set(errors)];
}

function validateObservation(observation, trustedRelayKeyIds = [], trustedOrgId = null, relaySecretConfig = {}, verificationConfig = null, trustedVerificationConfigDigest = null) {
  const schemaErrors = validateJsonSchema(schemas.observation, observation);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema observation ${error}`)] : [];
  errors.push(...validateFirefliesVerificationConfig(verificationConfig, trustedVerificationConfigDigest));
  if (digestWithout(observation, 'observationDigest') !== observation.observationDigest) errors.push('observationDigest mismatch');
  const verification = observation.signatureVerification;
  const expectedVerificationReceipt = sha256(jcs({ provider: observation.provider, providerSourceId: observation.providerSourceId, rawBodyDigest: observation.rawBodyDigest, scheme: verification.scheme, headerName: verification.headerName, headerValueDigest: verification.headerValueDigest, keyId: verification.keyId, keyConfigVersion: verification.keyConfigVersion, verificationConfigDigest: verification.verificationConfigDigest, providerDocsSource: verification.providerDocsSource, verifiedAt: verification.verifiedAt, verified: verification.verified }));
  if (verification.verificationReceiptDigest !== expectedVerificationReceipt) errors.push('provider verification receipt mismatch');
  if (verificationConfig) {
    const key = verificationConfig.keys.find((item) => item.keyId === verification.keyId);
    const verifiedAt = Date.parse(verification.verifiedAt);
    if (observation.provider !== verificationConfig.provider || observation.orgId !== verificationConfig.orgId || verification.keyConfigVersion !== verificationConfig.configVersion || verification.verificationConfigDigest !== verificationConfig.configDigest || verification.scheme !== verificationConfig.scheme || verification.headerName !== verificationConfig.headerName || verification.providerDocsSource !== verificationConfig.providerDocsSource || !key) errors.push('provider verification config binding mismatch');
    else if (verifiedAt < Date.parse(verificationConfig.validFrom) || verifiedAt > Date.parse(verificationConfig.validUntil) || verifiedAt < Date.parse(key.validFrom) || verifiedAt > Date.parse(key.validUntil)) errors.push('provider verification outside configured validity');
  }
  const expectedRelayIntent = sha256(jcs({ orgId: observation.orgId, observationId: observation.observationId, provider: observation.provider, providerSourceId: observation.providerSourceId, rawBodyDigest: observation.rawBodyDigest }));
  if (observation.relay.intentDigest !== expectedRelayIntent) errors.push('relay intent binding mismatch');
  const durable = observation.relay.durableReceipt;
  if (!durable) errors.push('relay durable observation receipt missing');
  else if (digestWithout(durable, 'receiptDigest') !== durable.receiptDigest || durable.observationId !== observation.observationId || durable.rawBodyDigest !== observation.rawBodyDigest || durable.storageKey !== `${observation.orgId}:${observation.observationId}`) errors.push('relay durable observation receipt mismatch');
  const auth = observation.relay.internalAuth;
  const replay = observation.relay.replayReceipt;
  const relaySecret = relaySecretConfig.secretsByKeyId?.[auth?.keyId] ?? null;
  if (!trustedOrgId || observation.orgId !== trustedOrgId) errors.push('internal relay key org mismatch');
  const completedRelay = observation.relay.state === 'RELAYED';
  if (completedRelay && (!auth || !replay || !observation.relay.relayReceiptDigest)) errors.push('relayed observation lacks completed auth/replay receipt');
  if (['RELAY_PENDING', 'LEASED', 'RETRYABLE', 'TERMINAL_FAILED'].includes(observation.relay.state) && (auth !== null || replay !== null || observation.relay.relayReceiptDigest !== null)) errors.push('pre-success relay state carries success receipt');
  if (auth) {
    if (!trustedRelayKeyIds.includes(auth.keyId) || !relaySecret) errors.push('untrusted internal relay key');
    if (auth.bodyDigest !== observation.rawBodyDigest) errors.push('relay auth body binding mismatch');
    const canonicalPayload = relayCanonicalPayload(observation);
    const canonicalDigest = sha256(canonicalPayload);
    if (auth.canonicalRequestDigest !== canonicalDigest) errors.push('relay canonical request mismatch');
    if (relaySecret) {
      const expectedMac = hmacHex(relaySecret, canonicalPayload);
      if (!constantTimeHexEqual(auth.macHex, expectedMac) || (completedRelay && !constantTimeHexEqual(observation.relay.relayReceiptDigest, expectedMac))) errors.push('relay HMAC mismatch');
    }
    const maximumSkew = (relaySecretConfig.maximumClockSkewSeconds ?? 300) * 1000;
    if (!Number.isFinite(Date.parse(auth.timestamp)) || Math.abs(Date.parse(auth.timestamp) - Date.parse(observation.receivedAt)) > maximumSkew) errors.push('relay auth timestamp skew');
  }
  if (replay) {
    const expectedNonceKey = sha256(jcs({ orgId: observation.orgId, keyId: auth?.keyId, nonce: auth?.nonce }));
    if (!auth || replay.nonceKey !== expectedNonceKey || replay.decision !== 'accepted_new') errors.push('relay replay receipt binding mismatch');
    const replayWindow = (relaySecretConfig.replayWindowSeconds ?? 300) * 1000;
    const acceptedAt = Date.parse(replay.acceptedAt), expiresAt = Date.parse(replay.expiresAt), authAt = Date.parse(auth?.timestamp);
    if (![acceptedAt, expiresAt, authAt].every(Number.isFinite) || acceptedAt < authAt || expiresAt <= acceptedAt || expiresAt - authAt > replayWindow) errors.push('relay replay window invalid');
    if (relaySecret && !constantTimeHexEqual(replay.receiptMacHex, hmacHex(relaySecret, replayReceiptPayload(observation)))) errors.push('relay replay receipt HMAC mismatch');
  }
  const receivedAt = Date.parse(observation.receivedAt), verifiedAt = Date.parse(verification.verifiedAt), persistedAt = Date.parse(durable?.persistedAt), firstAttemptAt = Date.parse(observation.relay.firstAttemptAt), lastUpdatedAt = Date.parse(observation.relay.lastUpdatedAt), deadlineAt = Date.parse(observation.relay.deadlineAt), leaseExpiresAt = Date.parse(observation.relay.leaseExpiresAt);
  if (![receivedAt, verifiedAt, persistedAt, lastUpdatedAt].every(Number.isFinite) || verifiedAt < receivedAt || persistedAt < verifiedAt || lastUpdatedAt < persistedAt) errors.push('relay durable chronology invalid');
  if (observation.relay.state === 'RELAY_PENDING') {
    if (observation.relay.firstAttemptAt !== null || observation.relay.deadlineAt !== null || lastUpdatedAt !== persistedAt) errors.push('pending relay chronology invalid');
  } else {
    if (![firstAttemptAt, deadlineAt].every(Number.isFinite) || firstAttemptAt < persistedAt || lastUpdatedAt < firstAttemptAt || deadlineAt < lastUpdatedAt || deadlineAt - firstAttemptAt > 30 * 60 * 1000) errors.push('relay attempt chronology invalid');
    if (observation.relay.leaseExpiresAt !== null && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt < lastUpdatedAt || leaseExpiresAt > deadlineAt)) errors.push('relay lease chronology invalid');
    if (auth && (Date.parse(auth.timestamp) < firstAttemptAt || Date.parse(auth.timestamp) > lastUpdatedAt)) errors.push('relay auth chronology invalid');
    if (replay && (Date.parse(replay.acceptedAt) < Date.parse(auth.timestamp) || Date.parse(replay.acceptedAt) > lastUpdatedAt)) errors.push('relay replay chronology invalid');
  }
  if (observation.relay.state === 'RELAYED' && observation.relay.errorCode !== null) errors.push('relayed observation carries error');
  return [...new Set(errors)];
}

function validateProcessingFailure(failure, observation) {
  const schemaErrors = validateJsonSchema(schemas.processingFailure, failure);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema processingFailure ${error}`)] : [];
  if (digestWithout(failure, 'failureDigest') !== failure.failureDigest) errors.push('failureDigest mismatch');
  if (failure.stage === 'ingress_persist') errors.push('pre-record failure uses observation-bound contract');
  if (!observation || failure.orgId !== observation.orgId || failure.observationId !== observation.observationId || failure.observationDigest !== observation.observationDigest || failure.providerSourceId !== observation.providerSourceId) errors.push('processing failure/observation binding mismatch');
  if (failure.paExceptionReceipt.state === 'SUCCEEDED' && (!failure.paExceptionReceipt.providerMessageId || !failure.paExceptionReceipt.readbackDigest)) errors.push('processing exception readback missing');
  const expectedReadback = sha256(jcs({ notificationKind: failure.paExceptionReceipt.notificationKind, sourceKey: failure.paExceptionReceipt.sourceKey, outboundDigest: failure.paExceptionReceipt.outboundDigest, providerMessageId: failure.paExceptionReceipt.providerMessageId, processingStatusPath: failure.paExceptionReceipt.processingStatusPath }));
  if (failure.paExceptionReceipt.state === 'SUCCEEDED' && failure.paExceptionReceipt.readbackDigest !== expectedReadback) errors.push('processing exception readback mismatch');
  if (failure.paExceptionReceipt.processingStatusPath !== failure.processingStatusPath) errors.push('processing exception path mismatch');
  return [...new Set(errors)];
}

function validatePreRecordIngressFailure(failure) {
  const schemaErrors = validateJsonSchema(schemas.preRecordIngressFailure, failure);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema preRecordIngressFailure ${error}`)] : [];
  if (digestWithout(failure, 'failureDigest') !== failure.failureDigest) errors.push('pre-record failureDigest mismatch');
  if (digestWithout(failure.sourceIdentity, 'sourceIdentityDigest') !== failure.sourceIdentity.sourceIdentityDigest) errors.push('pre-record source identity mismatch');
  const expectedByStage = {
    parse: ['INGRESS_PARSE_FAILED', 'PRE_RECORD_PARSE_FAILURE'],
    auth: ['INGRESS_AUTH_FAILED', 'PRE_RECORD_AUTH_FAILURE'],
    persist: ['INGRESS_PERSIST_FAILED', 'PRE_RECORD_PERSIST_FAILURE'],
  };
  const expected = expectedByStage[failure.stage];
  if (!expected || failure.errorCode !== expected[0] || failure.piiSafeAlertReceipt.errorCode !== expected[0] || failure.piiSafeAlertReceipt.summaryCode !== expected[1]) errors.push('pre-record stage/error binding mismatch');
  if (failure.piiSafeAlertReceipt.rawBodyIncluded !== false || failure.piiSafeAlertReceipt.providerPayloadIncluded !== false) errors.push('pre-record alert leaks provider payload');
  if (digestWithout(failure.piiSafeAlertReceipt, 'receiptDigest') !== failure.piiSafeAlertReceipt.receiptDigest) errors.push('pre-record alert receipt mismatch');
  const received = Date.parse(failure.sourceIdentity.receivedAt), failed = Date.parse(failure.failedAt), alerted = Date.parse(failure.piiSafeAlertReceipt.createdAt);
  if (![received, failed, alerted].every(Number.isFinite) || failed < received || alerted < failed) errors.push('pre-record failure/alert chronology invalid');
  if (failure.stage === 'auth') {
    if (failure.authenticationState !== 'unverified' || failure.encryptedQuarantine !== null || failure.deletionReceipt !== null) errors.push('auth failure retained unauthenticated provider body');
  } else {
    if (failure.authenticationState !== 'verified' || !failure.encryptedQuarantine || !failure.deletionReceipt) {
      errors.push('authenticated pre-record failure lacks quarantine/deletion');
    } else {
      const quarantine = failure.encryptedQuarantine;
      const deletion = failure.deletionReceipt;
      const encrypted = Date.parse(quarantine.encryptedAt), expires = Date.parse(quarantine.expiresAt), scheduled = Date.parse(deletion.scheduledFor), deleted = deletion.deletedAt === null ? null : Date.parse(deletion.deletedAt);
      if (![encrypted, expires, scheduled].every(Number.isFinite) || encrypted < received || encrypted > failed || expires <= encrypted || expires - received > 24 * 60 * 60 * 1000) errors.push('pre-record quarantine TTL invalid');
      if (!quarantine.reference.startsWith('encrypted-quarantine://')) errors.push('pre-record quarantine is not encrypted');
      if (deletion.quarantineReferenceDigest !== sha256(quarantine.reference) || digestWithout(deletion, 'receiptDigest') !== deletion.receiptDigest) errors.push('pre-record deletion receipt mismatch');
      if (scheduled < alerted || scheduled > expires || (deletion.state === 'DELETED' && (!Number.isFinite(deleted) || deleted < scheduled || deleted > expires)) || (deletion.state === 'SCHEDULED' && deletion.deletedAt !== null) || (quarantine.state === 'DELETED') !== (deletion.state === 'DELETED')) errors.push('pre-record deletion state invalid');
    }
  }
  return [...new Set(errors)];
}

function validateBriefsReadback(readback, record, delivery) {
  const schemaErrors = validateJsonSchema(schemas.briefsReadback, readback);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema briefsReadback ${error}`)] : [];
  if (!record || !delivery || readback.orgId !== record.orgId || readback.orgId !== delivery.orgId || readback.canonicalMeetingId !== record.canonicalMeetingId || readback.recordDigest !== record.recordDigest || readback.manifestRevision !== delivery.manifestRevision || readback.manifestDigest !== delivery.manifestDigest) errors.push('Briefs readback binding mismatch');
  const recordReadback = sha256(jcs({ canonicalMeetingId: record.canonicalMeetingId, recordDigest: record.recordDigest }));
  if (readback.recordReadbackDigest !== recordReadback) errors.push('Briefs record readbackDigest mismatch');
  const envelopeReadback = sha256(jcs({ canonicalMeetingId: delivery.canonicalMeetingId, manifestRevision: delivery.manifestRevision, manifestDigest: delivery.manifestDigest }));
  if (readback.envelopeReadbackDigest !== envelopeReadback) errors.push('Briefs envelope readbackDigest mismatch');
  const stored = sha256(jcs({ orgId: readback.orgId, canonicalMeetingId: readback.canonicalMeetingId, recordDigest: readback.recordDigest, recordReadbackDigest: readback.recordReadbackDigest }));
  if (readback.storedProjectionDigest !== stored) errors.push('Briefs stored projection digest mismatch');
  if (digestWithout(readback, 'readbackDigest') !== readback.readbackDigest) errors.push('Briefs readbackDigest mismatch');
  return [...new Set(errors)];
}

function validateBriefsOutput(output, record, coverage, evaluationClock, governedRecords = [record], delivery = null) {
  const schemaErrors = validateJsonSchema(schemas.briefsOutput, output);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema briefsOutput ${error}`)] : [];
  if (digestWithout(output, 'outputDigest') !== output.outputDigest) errors.push('Briefs outputDigest mismatch');
  if (output.orgId !== record.orgId || output.coverage.coverageSnapshotId !== coverage.coverageSnapshotId || output.coverage.snapshotDigest !== coverage.snapshotDigest || output.coverage.evaluationClockDigest !== evaluationClock.clockDigest || output.coverage.freshnessState !== coverage.freshness.state || output.coverage.asOf !== evaluationClock.asOf) errors.push('Briefs output coverage/freshness binding mismatch');
  const governedIds = governedRecords.map((item) => item.canonicalMeetingId);
  if (!unique(governedIds) || !jsonSetEqual(governedIds, coverage.recordIds) || !jsonSetEqual(output.cSurface.drillThroughMeetingIds, coverage.recordIds)) errors.push('Briefs aggregate record membership mismatch');
  const expectedRanking = governedRecords.map((item) => ({ canonicalMeetingId: item.canonicalMeetingId, movementScore: item.semanticViews.consequentialDeltaClaimIds.length, occurredAt: item.meeting.startedAt })).sort((left, right) => right.movementScore - left.movementScore || right.occurredAt.localeCompare(left.occurredAt) || left.canonicalMeetingId.localeCompare(right.canonicalMeetingId));
  const expectedNumerator = expectedRanking.filter((item) => item.movementScore > 0).length;
  const expectedDenominator = coverage.recordIds.length;
  const expectedRate = expectedDenominator ? expectedNumerator / expectedDenominator : 0;
  if (output.cSurface.numerator !== expectedNumerator || output.cSurface.denominator !== expectedDenominator || Math.abs(output.cSurface.rate - expectedRate) > Number.EPSILON) errors.push('Briefs aggregate numerator/denominator mismatch');
  if (output.cSurface.drillThroughDigest !== sha256(jcs([...output.cSurface.drillThroughMeetingIds].sort()))) errors.push('Briefs aggregate drill-through digest mismatch');
  if (jcs(expectedRanking) !== jcs(output.cSurface.ranking)) errors.push('Briefs aggregate ranking derivation mismatch');
  const expectedCards = governedRecords.map((item) => ({ canonicalMeetingId: item.canonicalMeetingId, recordDigest: item.recordDigest }));
  if (output.cSurface.meetingCards.length !== expectedCards.length || expectedCards.some((expected) => !output.cSurface.meetingCards.some((card) => card.canonicalMeetingId === expected.canonicalMeetingId && card.recordDigest === expected.recordDigest))) errors.push('Briefs aggregate card membership mismatch');
  if (output.bSurface.canonicalMeetingId !== record.canonicalMeetingId || output.bSurface.recordVersion !== record.recordVersion || output.bSurface.recordDigest !== record.recordDigest || output.bSurface.freshnessState !== coverage.freshness.state || output.bSurface.asOf !== evaluationClock.asOf) errors.push('Briefs rich-record binding mismatch');
  const labels = new Set(output.bSurface.claimLabels.map((item) => item.label));
  if (['fact', 'inference', 'proposal'].some((label) => !labels.has(label))) errors.push('Briefs claim labels incomplete');
  const evidenceById = new Map(output.bSurface.sourceEvidence.map((item) => [item.evidenceId, item]));
  for (const displayed of output.bSurface.claimLabels) {
    const claim = record.claims.find((item) => item.claimId === displayed.claimId && item.canonicalClaimId === displayed.canonicalClaimId);
    if (!claim || displayed.label !== claim.claimKind || displayed.disposition !== claim.disposition.state || displayed.semanticClass !== claim.semanticClass || !jsonSetEqual(displayed.evidenceRefs, claim.evidenceRefs)) errors.push('Briefs claim/disposition label binding mismatch');
    for (const evidenceId of displayed.evidenceRefs) if (!evidenceById.has(evidenceId)) errors.push('Briefs claim evidence drill-through missing');
  }
  for (const displayed of output.bSurface.sourceEvidence) {
    const evidence = record.evidenceRegistry.find((item) => item.evidenceId === displayed.evidenceId);
    const source = record.sourceObservations.find((item) => item.sourceId === evidence?.sourceId);
    if (!evidence || !source || displayed.sourceId !== evidence.sourceId || displayed.artifactId !== evidence.artifactId || displayed.quoteDigest !== evidence.quoteDigest || displayed.sourceLineageDigest !== source.lineageDigest) errors.push('Briefs source evidence binding mismatch');
  }
  const links = new Map(output.cToBLinks.map((link) => [link.canonicalMeetingId, link]));
  for (const link of output.cToBLinks) {
    const expectedDigest = sha256(jcs({ canonicalMeetingId: link.canonicalMeetingId, recordDigest: link.recordDigest, fromPath: link.fromPath, toPath: link.toPath }));
    if (link.linkDigest !== expectedDigest) errors.push('Briefs C-to-B link digest mismatch');
  }
  for (const card of output.cSurface.meetingCards) {
    const link = links.get(card.canonicalMeetingId);
    if (!link || link.recordDigest !== card.recordDigest || link.toPath !== card.bPath || link.linkDigest !== card.linkDigest || !output.cSurface.drillThroughMeetingIds.includes(card.canonicalMeetingId)) errors.push('Briefs C-to-B drill-through mismatch');
  }
  const richLink = links.get(output.bSurface.canonicalMeetingId);
  if (!richLink || richLink.recordDigest !== output.bSurface.recordDigest || richLink.fromPath !== output.bSurface.cPath) errors.push('Briefs rich-record back-link mismatch');
  const sections = output.bSurface.sections;
  const requiredSections = ['structuredSummary', 'participants', 'topics', 'decisions', 'discovery', 'changes', 'commitmentsDates', 'lifecycle', 'followUpDraft', 'artifactsEvidence', 'recurringThemes', 'sinkReceiptsFreshness'];
  if (!sections || requiredSections.some((section) => sections[section] === undefined)) errors.push('Briefs rich required section missing');
  else {
  const expectedSemantic = record.semanticViews;
  if (sections.structuredSummary.headlineClaimId !== expectedSemantic.headlineClaimId || sections.structuredSummary.narrativeClaimId !== expectedSemantic.narrativeClaimId) errors.push('Briefs rich section summary mismatch');
  const claimRefFields = [['topics', 'topicClaimIds', 'topicClaimIds'], ['topics', 'subtopicClaimIds', 'subtopicClaimIds'], ['decisions', 'decisionClaimIds', 'decisionClaimIds'], ['decisions', 'rationaleClaimIds', 'rationaleClaimIds'], ['discovery', 'needClaimIds', 'needClaimIds'], ['discovery', 'questionClaimIds', 'questionClaimIds'], ['discovery', 'objectionClaimIds', 'objectionClaimIds'], ['discovery', 'opportunityClaimIds', 'opportunityClaimIds'], ['changes', 'projectChangeClaimIds', 'projectChangeClaimIds'], ['changes', 'dealChangeClaimIds', 'dealChangeClaimIds'], ['changes', 'accountChangeClaimIds', 'accountChangeClaimIds'], ['changes', 'relationshipChangeClaimIds', 'relationshipChangeClaimIds'], ['recurringThemes', 'claimIds', 'recurringThemeClaimIds']];
  for (const [section, field, semanticField] of claimRefFields) if (!jsonSetEqual(sections[section][field], expectedSemantic[semanticField])) errors.push('Briefs rich section claim reference mismatch');
  const expectedParticipants = record.participants.map((participant) => ({ participantId: participant.participantId, roleClaimIds: [...participant.roleClaimIds], relationshipClassClaimId: participant.relationshipClassClaimId }));
  const expectedCommitments = record.claims.filter((claim) => claim.semanticClass === 'work_item').map((claim) => claim.canonicalClaimId);
  if (jcs(sections.participants) !== jcs(expectedParticipants) || !jsonSetEqual(sections.commitmentsDates.canonicalClaimIds, expectedCommitments)) errors.push('Briefs rich section participant/commitment mismatch');
  if (jcs(sections.lifecycle) !== jcs(record.lifecycle) || !jsonSetEqual(sections.artifactsEvidence.artifactIds, record.artifacts.map((item) => item.artifactId)) || !jsonSetEqual(sections.artifactsEvidence.evidenceIds, record.evidenceRegistry.map((item) => item.evidenceId))) errors.push('Briefs rich section evidence/lifecycle mismatch');
  if (sections.sinkReceiptsFreshness.freshnessState !== coverage.freshness.state || sections.sinkReceiptsFreshness.asOf !== evaluationClock.asOf) errors.push('Briefs rich section freshness mismatch');
  if (delivery) {
    if (sections.followUpDraft.state !== delivery.followUpDraft.state || sections.followUpDraft.draftId !== delivery.followUpDraft.draftId || sections.followUpDraft.bodyDigest !== delivery.followUpDraft.bodyDigest) errors.push('Briefs rich section follow-up mismatch');
    if (!jsonSetEqual(sections.sinkReceiptsFreshness.sinks.map((item) => `${item.sink}:${item.state}`), delivery.upstreamReceipts.map((item) => `${item.sink}:${item.state}`))) errors.push('Briefs rich section sink receipt mismatch');
  }
  }
  return [...new Set(errors)];
}

const wilsonLowerBound = (successes, total, z = 1) => {
  if (!total) return 0;
  const p = successes / total, z2 = z * z;
  return (p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total);
};
function validateSemanticEvaluation(evaluation, dataset = null) {
  const schemaErrors = validateJsonSchema(schemas.semanticEvaluation, evaluation);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema semanticEvaluation ${error}`)] : [];
  if (!dataset) errors.push('semantic evaluation dataset missing');
  else {
    const datasetSchemaErrors = validateJsonSchema(schemas.semanticDataset, dataset);
    if (datasetSchemaErrors.length) errors.push('semantic evaluation dataset schema invalid');
    if (digestWithout(dataset, 'datasetDigest') !== dataset.datasetDigest || evaluation.datasetDigest !== dataset.datasetDigest || dataset.meetingSplitDigest !== evaluation.meetingSplit.splitDigest) errors.push('semantic evaluation dataset binding mismatch');
  }
  if (digestWithout(evaluation, 'evaluationDigest') !== evaluation.evaluationDigest) errors.push('semantic evaluationDigest mismatch');
  const requiredDimensions = ['direction', 'work_state', 'evidence_grounding', 'due', 'dependency', 'context_class', 'identity'];
  if (!jsonSetEqual(evaluation.requiredDimensions, requiredDimensions)) errors.push('semantic required dimensions mismatch');
  const split = evaluation.meetingSplit;
  const expectedSplitDigest = sha256(jcs({ policyVersion: split.policyVersion, trainingMeetingIds: [...split.trainingMeetingIds].sort(), evaluationMeetingIds: [...split.evaluationMeetingIds].sort() }));
  if (split.splitDigest !== expectedSplitDigest || split.trainingMeetingIds.some((id) => split.evaluationMeetingIds.includes(id))) errors.push('semantic meeting-level split mismatch');
  const strataByDimension = new Map(evaluation.strata.map((stratum) => [stratum.dimension, stratum]));
  if (strataByDimension.size !== requiredDimensions.length || requiredDimensions.some((dimension) => !strataByDimension.has(dimension))) errors.push('semantic required stratum missing');
  let anyUnderSupported = false;
  let anyFailed = false;
  for (const stratum of evaluation.strata) {
    const examples = dataset?.examples.filter((item) => item.stratumId === stratum.stratumId && item.dimension === stratum.dimension) ?? [];
    const positives = examples.filter((item) => item.truth).map((item) => item.meetingId);
    const negatives = examples.filter((item) => !item.truth).map((item) => item.meetingId);
    const positiveCount = positives.length;
    const negativeCount = negatives.length;
    const supported = positiveCount >= evaluation.thresholdPolicy.minimumPositive && negativeCount >= evaluation.thresholdPolicy.minimumNegative;
    if (!supported) anyUnderSupported = true;
    if (!jsonSetEqual(stratum.positiveMeetingIds, positives) || !jsonSetEqual(stratum.negativeMeetingIds, negatives)) errors.push('semantic dataset stratum membership mismatch');
    if (stratum.positiveMeetingIds.some((id) => !split.evaluationMeetingIds.includes(id)) || stratum.negativeMeetingIds.some((id) => !split.evaluationMeetingIds.includes(id)) || stratum.positiveMeetingIds.some((id) => stratum.negativeMeetingIds.includes(id))) errors.push('semantic stratum meeting split mismatch');
    const truePositive = examples.filter((item) => item.truth && item.prediction).length, falsePositive = examples.filter((item) => !item.truth && item.prediction).length, falseNegative = examples.filter((item) => item.truth && !item.prediction).length, trueNegative = examples.filter((item) => !item.truth && !item.prediction).length;
    if (stratum.truePositive !== truePositive || stratum.falsePositive !== falsePositive || stratum.falseNegative !== falseNegative || stratum.trueNegative !== trueNegative) errors.push('semantic stratum confusion counts mismatch');
    const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
    const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
    const accuracy = examples.length ? (truePositive + trueNegative) / examples.length : 0;
    const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
    const confidenceLowerBound = wilsonLowerBound(truePositive + trueNegative, examples.length, 1);
    if ([['precision', precision], ['recall', recall], ['accuracy', accuracy], ['f1', f1], ['confidenceLowerBound', confidenceLowerBound]].some(([field, expected]) => Math.abs(stratum[field] - expected) > 1e-12) || stratum.support !== examples.length) errors.push('semantic stratum metric mismatch');
    const passesThreshold = supported && precision >= evaluation.thresholdPolicy.minimumPrecision && recall >= evaluation.thresholdPolicy.minimumRecall && accuracy >= evaluation.thresholdPolicy.minimumAccuracy && stratum.confidenceLowerBound >= evaluation.thresholdPolicy.minimumConfidenceLowerBound;
    const expectedStatus = !supported ? 'not_proven' : passesThreshold ? 'pass' : 'fail';
    if (stratum.status !== expectedStatus) errors.push('semantic stratum status mismatch');
    if (expectedStatus === 'fail') anyFailed = true;
  }
  const expectedOverall = anyUnderSupported ? 'not_proven' : anyFailed ? 'fail' : 'pass';
  if (evaluation.overallStatus !== expectedOverall) errors.push(evaluation.overallStatus === 'pass' ? 'semantic aggregate masks failing stratum' : 'semantic overall status mismatch');
  const counterexampleStrata = new Set();
  for (const counterexample of evaluation.counterexamples) {
    counterexampleStrata.add(counterexample.stratumId);
    const expectedPath = `/business/crm/meetings/${counterexample.meetingId}?evidence=${counterexample.evidenceId}`;
    if (!split.evaluationMeetingIds.includes(counterexample.meetingId) || counterexample.drillThroughPath !== expectedPath) errors.push('semantic counterexample drill-through mismatch');
  }
  if (evaluation.strata.some((stratum) => !counterexampleStrata.has(stratum.stratumId))) errors.push('semantic stratum counterexample missing');
  if (dataset) {
    for (const counterexample of evaluation.counterexamples) if (!dataset.examples.some((item) => item.stratumId === counterexample.stratumId && item.meetingId === counterexample.meetingId && item.evidenceId === counterexample.evidenceId)) errors.push('semantic counterexample dataset evidence mismatch');
    const expectedMetricReceipt = sha256(jcs({ datasetDigest: dataset.datasetDigest, meetingSplitDigest: evaluation.meetingSplit.splitDigest, strata: evaluation.strata.map((item) => ({ stratumId: item.stratumId, truePositive: item.truePositive, falsePositive: item.falsePositive, falseNegative: item.falseNegative, trueNegative: item.trueNegative, precision: item.precision, recall: item.recall, accuracy: item.accuracy, f1: item.f1, support: item.support, confidenceLowerBound: item.confidenceLowerBound, status: item.status })) }));
    if (evaluation.metricReceiptDigest !== expectedMetricReceipt) errors.push('semantic metric receipt mismatch');
  }
  return [...new Set(errors)];
}

function validatePaReceiptBinding(receipt, delivery, record, predecessorReceipt = null, previousRecord = null) {
  if (!receipt) return [];
  const errors = [];
  const expectedPrefix = `meeting:${record.canonicalMeetingId}:v${record.recordVersion}:pa:${receipt.notificationKind}`;
  if (receipt.recordDigest !== record.recordDigest || delivery.recordDigest !== record.recordDigest) errors.push('PA receipt record binding mismatch');
  if (receipt.sourceKey !== expectedPrefix || receipt.idempotencyKey !== `${record.orgId}:${expectedPrefix}`) errors.push('PA receipt identity binding mismatch');
  if (['normal_completion', 'correction'].includes(receipt.notificationKind) && receipt.durablePath !== `/business/crm/meetings/${record.canonicalMeetingId}`) errors.push('PA receipt durable path mismatch');
  if (receipt.notificationKind === 'normal_completion' && receipt.consequentialDeltaDigest !== consequentialDeltaDigest(record)) errors.push('PA consequential delta binding mismatch');
  if (receipt.notificationKind === 'correction') {
    if (!previousRecord || previousRecord.orgId !== record.orgId || previousRecord.canonicalMeetingId !== record.canonicalMeetingId || previousRecord.recordDigest === record.recordDigest || record.recordVersion !== previousRecord.recordVersion + 1) errors.push('PA correction record transition missing');
    const expectedDelta = previousRecord ? meetingRecordDeltaDigest(previousRecord, record) : null;
    if (receipt.correctionDeltaDigest !== expectedDelta || receipt.consequentialDeltaDigest !== consequentialDeltaDigest(record)) errors.push('PA correction delta binding mismatch');
    if (receipt.predecessorProviderMessageId !== receipt.correctsProviderMessageId) errors.push('PA correction predecessor message mismatch');
    if (!predecessorReceipt || receipt.predecessorReceiptDigest !== predecessorReceipt.readbackDigest || receipt.predecessorSourceKey !== predecessorReceipt.sourceKey || receipt.predecessorProviderMessageId !== predecessorReceipt.providerMessageId) errors.push('PA correction predecessor receipt mismatch');
  }
  if (receipt.state === 'SUCCEEDED' && receipt.readbackDigest !== paReadbackDigest(receipt)) errors.push('PA delivery readback binding mismatch');
  return [...new Set(errors)];
}

function validateFirefliesVectors(vectors, observation = null, secretConfig = {}) {
  const errors = [];
  if (vectors.authoritativeSource !== 'https://docs.fireflies.ai/graphql-api/webhooks-v2') errors.push('Fireflies authority source mismatch');
  for (const vector of vectors.vectors) {
    const secret = secretConfig.secretsByKeyId?.[vector.secretKeyId] ?? null;
    const exactHeader = vector.headerName === 'X-Hub-Signature';
    const exactScheme = vector.scheme === 'hmac-sha256-raw-body';
    const exactFormat = /^sha256=[0-9a-f]{64}$/.test(vector.headerValue);
    const presentedHex = exactFormat ? vector.headerValue.slice('sha256='.length) : null;
    const expectedHex = secret ? hmacHex(secret, Buffer.from(vector.rawBodyUtf8, 'utf8')) : null;
    const signatureMatches = secret && presentedHex ? constantTimeHexEqual(presentedHex, expectedHex) : false;
    const accepted = Boolean(exactHeader && exactScheme && exactFormat && signatureMatches);
    if ((vector.expected === 'accept') !== accepted) errors.push(`Fireflies vector mismatch: ${vector.name}`);
  }
  const valid = vectors.vectors.find((vector) => vector.expected === 'accept');
  if (observation && valid && (valid.headerName !== 'X-Hub-Signature' || valid.scheme !== 'hmac-sha256-raw-body' || !/^sha256=[0-9a-f]{64}$/.test(valid.headerValue) || sha256(valid.rawBodyUtf8) !== observation.rawBodyDigest || sha256(valid.headerValue) !== observation.signatureVerification.headerValueDigest || observation.signatureVerification.headerName !== valid.headerName || observation.signatureVerification.scheme !== valid.scheme || observation.signatureVerification.providerDocsSource !== vectors.authoritativeSource)) errors.push('Fireflies observation/vector binding mismatch');
  return errors;
}

function validateRecord(record, dispositionSet, registry, authorityRoot, trustedAuthorityRootDigest, identityOverride, crmProjection) {
  const schemaErrors = validateJsonSchema(schemas.record, record);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema record ${error}`)] : [];
  if (recordDigest(record) !== record.recordDigest) errors.push('recordDigest mismatch');
  const sourceIds = record.sourceObservations.map((item) => item.sourceId);
  if (!unique(sourceIds)) errors.push('duplicate sourceId');
  if (record.sourceObservations.filter((item) => item.state === 'active').length !== 1) errors.push('active source count');
  for (const source of record.sourceObservations) {
    if (source.state === 'active' && (source.supersededBy !== null || source.tombstoneId !== null || source.reingestAllowed !== true || source.retiredIdentity !== false)) errors.push('active source disposition invalid');
    if (source.state !== 'active' && (!source.supersededBy || !source.tombstoneId || source.reingestAllowed !== false || source.retiredIdentity !== true)) errors.push('retired source lacks tombstone');
    if (source.state !== 'active' && (!sourceIds.includes(source.supersededBy) || source.supersededBy === source.sourceId)) errors.push('retired source target invalid');
  }
  const sourcesForChain = new Map(record.sourceObservations.map((source) => [source.sourceId, source]));
  for (const source of record.sourceObservations.filter((item) => item.state !== 'active')) {
    const seen = new Set([source.sourceId]);
    let cursor = source;
    while (cursor?.state !== 'active') {
      if (!cursor?.supersededBy || seen.has(cursor.supersededBy)) { errors.push('source supersession chain invalid'); break; }
      seen.add(cursor.supersededBy);
      cursor = sourcesForChain.get(cursor.supersededBy);
      if (!cursor) { errors.push('source supersession chain invalid'); break; }
    }
  }
  if (!unique(record.sourceObservations.map((item) => item.tombstoneId).filter(Boolean))) errors.push('duplicate source tombstone');
  const claimIds = record.claims.map((claim) => claim.claimId);
  const canonicalClaimIds = record.claims.map((claim) => claim.canonicalClaimId);
  if (!unique(claimIds)) errors.push('duplicate claimId');
  if (!unique(canonicalClaimIds)) errors.push('duplicate canonicalClaimId');
  const claimSet = new Set(claimIds);
  const claimsById = new Map(record.claims.map((claim) => [claim.claimId, claim]));
  const canonicalSet = new Set(canonicalClaimIds);
  const evidenceSet = new Set(record.evidenceRegistry.map((item) => item.evidenceId));
  if (evidenceSet.size !== record.evidenceRegistry.length) errors.push('duplicate evidenceId');
  if (!unique(record.artifacts.map((item) => item.artifactId))) errors.push('duplicate artifactId');
  const artifactsById = new Map(record.artifacts.map((item) => [item.artifactId, item]));
  const sourcesById = new Map(record.sourceObservations.map((item) => [item.sourceId, item]));
  const requireSemantic = (ref, allowed, requireAuthoritative = false) => {
    const claim = claimsById.get(ref);
    if (!claim) return errors.push('unresolved semantic claim ref');
    if (!allowed.includes(claim.semanticClass)) errors.push('semantic class mismatch');
    if (requireAuthoritative && (claim.claimKind !== 'fact' || claim.disposition.state !== 'accepted' || claim.disposition.authority === null)) errors.push('semantic eligibility mismatch');
  };
  requireSemantic(record.meeting.contextClassClaimId, ['context_class'], true);
  for (const participant of record.participants) {
    for (const ref of participant.roleClaimIds) requireSemantic(ref, ['participant_role'], true);
    requireSemantic(participant.relationshipClassClaimId, ['relationship_class'], true);
  }
  requireSemantic(record.semanticViews.headlineClaimId, ['headline']);
  requireSemantic(record.semanticViews.narrativeClaimId, ['narrative']);
  for (const ref of record.semanticViews.consequentialDeltaClaimIds) requireSemantic(ref, ['consequential_delta', 'decision', 'work_item'], true);
  const viewClass = { topicClaimIds: 'topic', subtopicClaimIds: 'subtopic', decisionClaimIds: 'decision', rationaleClaimIds: 'rationale', needClaimIds: 'need', questionClaimIds: 'question', objectionClaimIds: 'objection', opportunityClaimIds: 'opportunity', relationshipChangeClaimIds: 'relationship_change', projectChangeClaimIds: 'project_change', dealChangeClaimIds: 'deal_change', accountChangeClaimIds: 'account_change', recurringThemeClaimIds: 'recurring_theme' };
  for (const [field, semanticClass] of Object.entries(viewClass)) for (const ref of record.semanticViews[field]) requireSemantic(ref, [semanticClass]);
  for (const evidence of record.evidenceRegistry) {
    if (!sourceIds.includes(evidence.sourceId)) errors.push('unresolved evidence source');
    const artifact = artifactsById.get(evidence.artifactId);
    const source = sourcesById.get(evidence.sourceId);
    if (!artifact) errors.push('unresolved evidence artifact');
    if (artifact && (artifact.sourceId !== evidence.sourceId || artifact.sourceLineageDigest !== source?.lineageDigest)) errors.push('evidence artifact lineage mismatch');
    if (evidence.endMs < evidence.startMs) errors.push('negative evidence span');
    if (source && evidence.endMs > source.durationSeconds * 1000) errors.push('evidence span exceeds source');
  }
  for (const source of record.sourceObservations) {
    const artifactCount = record.artifacts.filter((artifact) => artifact.sourceId === source.sourceId).length;
    if (artifactCount !== source.evidenceArtifactCount) errors.push('source artifact count mismatch');
    if ((source.transcriptState === 'available') !== Boolean(source.transcriptDigest)) errors.push('transcript availability mismatch');
  }
  for (const claim of record.claims) {
    if (candidateContentDigest(claim) !== claim.candidateContentDigest) errors.push('candidateContentDigest mismatch');
    if (claimIdentityBasisDigest(record, claim) !== claim.identityBasisDigest) errors.push('identityBasisDigest mismatch');
    if (!claim.evidenceRefs.length) errors.push('claim missing evidence');
    for (const ref of [...claim.evidenceRefs, ...claim.due.groundingEvidenceRefs]) if (!evidenceSet.has(ref)) errors.push('unresolved evidence ref');
    const authoritativeFact = claim.claimKind === 'fact' && claim.disposition.state === 'accepted' && claim.disposition.authority !== null;
    if (!authoritativeFact && Object.values(claim.materialization).some(Boolean)) errors.push('non-authoritative claim materializes');
    if (claim.disposition.state === 'proposed' && claim.disposition.authority !== null) errors.push('proposed claim has authority');
    if (claim.disposition.state !== 'proposed' && claim.disposition.authority === null) errors.push('accepted claim lacks authority');
    if (claim.materialization.task && (claim.semanticClass !== 'work_item' || !claim.ownerId || !['josh_owned', 'external_owned', 'shared'].includes(claim.direction))) errors.push('materialized task lacks grounded work identity');
    if (claim.workState === 'completed' && !claim.closure.completedAt) errors.push('completed work lacks timestamp');
    if (claim.due.state === 'known' && (!claim.due.at || !claim.due.groundingEvidenceRefs.length)) errors.push('known due lacks grounding');
    if (claim.due.state !== 'known' && (claim.due.at !== null || claim.due.groundingEvidenceRefs.length)) errors.push('non-known due carries value');
    if (claim.dependency.kind === 'none' && (claim.dependency.description !== null || claim.dependency.ownerId !== null || claim.dependency.satisfied !== null)) errors.push('none dependency carries state');
    if (claim.dependency.kind !== 'none' && (!claim.dependency.description || typeof claim.dependency.satisfied !== 'boolean')) errors.push('active dependency incomplete');
    if (claim.dependency.kind === 'person' && !claim.dependency.ownerId) errors.push('person dependency lacks owner');
    if (['completed', 'closed_abandoned'].includes(claim.workState) && !claim.closure.completedAt) errors.push('closed work lacks completion');
    if (!['completed', 'closed_abandoned'].includes(claim.workState) && (claim.closure.reason !== null || claim.closure.completedAt !== null)) errors.push('open work carries closure');
    if (claim.supersedesClaimId && (!record.previousRecordDigest || claim.supersedesClaimId === claim.claimId)) errors.push('invalid supersedes claim');
  }
  const lifecycle = Object.values(record.lifecycle);
  const flat = lifecycle.flat();
  if (!unique(flat)) errors.push('lifecycle overlap');
  for (const ref of flat) if (!canonicalSet.has(ref)) errors.push('unresolved lifecycle ref');
  const claimsByCanonical = new Map(record.claims.map((claim) => [claim.canonicalClaimId, claim]));
  for (const ref of record.lifecycle.myTasks) {
    const claim = claimsByCanonical.get(ref);
    if (!claim || claim.semanticClass !== 'work_item' || !['josh_owned', 'shared'].includes(claim.direction) || !['open', 'contingent'].includes(claim.workState) || claim.materialization.task !== true) errors.push('myTasks lifecycle mismatch');
  }
  for (const ref of record.lifecycle.waitingOnThem) {
    const claim = claimsByCanonical.get(ref);
    if (!claim || claim.semanticClass !== 'work_item' || claim.direction !== 'external_owned' || claim.workState !== 'waiting' || claim.materialization.task !== true || claim.dependency.kind === 'none' || claim.dependency.ownerId !== claim.ownerId || claim.dependency.satisfied !== false) errors.push('waitingOnThem lifecycle mismatch');
  }
  for (const ref of record.lifecycle.completedClosed) {
    const claim = claimsByCanonical.get(ref);
    if (!claim || claim.semanticClass !== 'work_item' || !['completed', 'closed_abandoned'].includes(claim.workState)) errors.push('completedClosed lifecycle mismatch');
  }
  for (const ref of record.lifecycle.notTasks) {
    const claim = claimsByCanonical.get(ref);
    if (!claim || claim.semanticClass !== 'work_item' || claim.workState !== 'not_a_task' || claim.materialization.task !== false) errors.push('notTasks lifecycle mismatch');
  }
  const expectedLifecycle = new Set(record.claims.filter((claim) => claim.semanticClass === 'work_item' && claim.disposition.state === 'accepted').map((claim) => claim.canonicalClaimId));
  if (expectedLifecycle.size !== flat.length || [...expectedLifecycle].some((ref) => !flat.includes(ref))) errors.push('lifecycle projection incomplete');
  if (!dispositionSet || !registry || !authorityRoot) errors.push('missing independent disposition authority');
  else errors.push(...validateDispositionJoin(record, dispositionSet, registry, authorityRoot, trustedAuthorityRootDigest));
  if (record.identityPolicy.overrideDigest !== null) {
    if (!identityOverride || identityOverride.overrideDigest !== record.identityPolicy.overrideDigest || identityOverride.overrideId !== record.identityPolicy.overrideId || identityOverride.overrideVersion !== record.identityPolicy.overrideVersion) errors.push('identity override binding mismatch');
    else {
      if (identityOverride.canonicalSourceId !== record.sourceObservations.find((source) => source.state === 'active')?.sourceId) errors.push('identity override canonical mismatch');
      if (!jsonSetEqual(identityOverride.sourceIds, sourceIds)) errors.push('identity override source set mismatch');
      errors.push(...validateIdentityOverride(identityOverride, authorityRoot));
    }
  } else {
    const selected = [...record.sourceObservations].sort(compareSourcePreference)[0];
    if (selected?.sourceId !== record.sourceObservations.find((source) => source.state === 'active')?.sourceId) errors.push('deterministic source selection mismatch');
  }
  if (record.meeting.associationState === 'crm_confirmed') {
    if (!crmProjection || record.meeting.crmContextVersion !== crmProjection.projectionVersion || record.meeting.crmContextDigest !== crmProjection.projectionDigest) errors.push('CRM context binding mismatch');
    const entityIds = {
      accountIds: new Set(crmProjection?.accounts.map((item) => item.accountId) ?? []),
      contactIds: new Set(crmProjection?.contacts.map((item) => item.contactId) ?? []),
      engagementIds: new Set(crmProjection?.engagements.map((item) => item.engagementId) ?? []),
    };
    for (const [field, ids] of Object.entries(entityIds)) for (const id of record.meeting[field]) if (!ids.has(id)) errors.push('unresolved CRM association');
  }
  return [...new Set(errors)];
}

function validateDelivery(delivery) {
  const schemaErrors = validateJsonSchema(schemas.delivery, delivery);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema delivery ${error}`)] : [];
  if (deliveryManifestDigest(delivery) !== delivery.manifestDigest) errors.push('manifestDigest mismatch');
  const expected = ['briefs_projection', 'crm_interaction', 'lifecycle_projection', 'followup_draft'];
  const sinks = delivery.upstreamReceipts.map((receipt) => receipt.sink);
  if (!unique(sinks) || expected.some((sink) => !sinks.includes(sink)) || sinks.length !== expected.length) errors.push('required sink set invalid');
  for (const receipt of delivery.upstreamReceipts) {
    if (receipt.recordDigest !== delivery.recordDigest) errors.push('receipt record digest mismatch');
    if (receipt.state === 'SUCCEEDED' && (!receipt.readbackDigest || !receipt.providerId)) errors.push('succeeded receipt lacks readback');
    if (receipt.state === 'SKIPPED_POLICY' && receipt.sink !== 'followup_draft') errors.push('only followup may skip');
    if (receipt.state === 'SKIPPED_POLICY' && (!receipt.policyVersion || !receipt.reason)) errors.push('policy skip lacks policy');
    if (['RETRYABLE', 'TERMINAL_FAILED'].includes(receipt.state) && !receipt.errorCode) errors.push('failed receipt lacks error code');
    errors.push(...validateAttemptReceipt(receipt));
    if (receipt.state === 'SUCCEEDED' && sinkReadbackDigest(receipt) !== receipt.readbackDigest) errors.push('sink readbackDigest mismatch');
  }
  const draft = delivery.followUpDraft;
  if (draft.state === 'drafted' && (!draft.draftId || !draft.bodyDigest || !draft.subject)) errors.push('drafted output incomplete');
  if (draft.state === 'not_required' && (draft.applicability !== 'not_required' || !draft.reason || draft.draftId || draft.bodyDigest)) errors.push('draft skip invalid');
  if (!unique(delivery.crm.writeIntents.map((item) => item.intentId)) || !unique(delivery.crm.writeIntents.map(intentIdentity))) errors.push('CRM delivery intent set duplicate identity');
  for (const intent of delivery.crm.writeIntents) {
    errors.push(...validateExactOperationBinding(intent));
    if (!CRM_ALLOWED_OPERATIONS.includes(intent.operation)) errors.push('CRM delivery operation domain mismatch');
    if (!CRM_DURABLE_STATES.includes(intent.state)) errors.push('CRM delivery state domain mismatch');
    if (!intent.canonicalClaimId) errors.push('CRM intent missing canonical claim');
    if (intent.state === 'applied' && (!intent.authoritativeReadbackVersion || !intent.authoritativeReadbackDigest)) errors.push('applied CRM intent lacks readback');
    if (['rejected', 'terminal_failed'].includes(intent.state) && !intent.rejectionCode) errors.push('terminal CRM intent lacks code');
  }
  if (delivery.paDeliveryReceipt) {
    if (delivery.paDeliveryReceipt.sink !== 'pa_telegram') errors.push('PA receipt sink invalid');
    if (delivery.paDeliveryReceipt.state === 'SUCCEEDED' && (!delivery.paDeliveryReceipt.providerMessageId || !delivery.paDeliveryReceipt.readbackDigest)) errors.push('succeeded PA receipt lacks readback');
    errors.push(...validateAttemptReceipt(delivery.paDeliveryReceipt));
    if (delivery.paDeliveryReceipt.notificationKind === 'correction' && delivery.paDeliveryReceipt.predecessorProviderMessageId !== delivery.paDeliveryReceipt.correctsProviderMessageId) errors.push('PA correction predecessor message mismatch');
  }
  const upstreamSatisfied = delivery.upstreamReceipts.every((receipt) => receipt.state === 'SUCCEEDED' || (receipt.sink === 'followup_draft' && receipt.state === 'SKIPPED_POLICY'));
  const failed = delivery.upstreamReceipts.filter((receipt) => receipt.state === 'TERMINAL_FAILED');
  if (delivery.paDeliveryReceipt?.notificationKind === 'terminal_exception' && (!failed.length || !failed.some((receipt) => receipt.sink === delivery.paDeliveryReceipt.failedSink))) errors.push('terminal exception lacks matching failed sink');
  if (['normal_completion', 'correction'].includes(delivery.paDeliveryReceipt?.notificationKind) && !upstreamSatisfied) errors.push('normal PA receipt without upstream readiness');
  return [...new Set(errors)];
}

function validateAttemptReceipt(receipt) {
  const errors = [];
  const first = Date.parse(receipt.firstAttemptAt), deadline = Date.parse(receipt.deadlineAt), updated = Date.parse(receipt.updatedAt);
  if (![first, deadline, updated].every(Number.isFinite) || receipt.attempt > 5 || deadline < first || deadline - first > 30 * 60 * 1000 || updated < first || updated > deadline) errors.push('retry attempt bounds invalid');
  if (receipt.state === 'UNKNOWN_COMMIT' && (receipt.unknownProbeCount < 1 || receipt.unknownProbeCount > 3 || !receipt.lastProbeAt)) errors.push('unknown commit probe bounds invalid');
  if (receipt.state === 'UNKNOWN_COMMIT' && receipt.lastProbeAt) {
    const lastProbe = Date.parse(receipt.lastProbeAt);
    if (!Number.isFinite(lastProbe) || lastProbe < first || lastProbe > Math.min(first + 15 * 60 * 1000, deadline) || lastProbe > updated) errors.push('unknown commit probe timing invalid');
  }
  if (receipt.state === 'UNKNOWN_COMMIT' && receipt.nextAttemptAt !== null) errors.push('unknown commit schedules blind retry');
  if (receipt.state === 'RETRYABLE' && (!receipt.nextAttemptAt || Date.parse(receipt.nextAttemptAt) <= updated)) errors.push('retryable receipt lacks bounded next attempt');
  if (receipt.state === 'RETRYABLE' && receipt.nextAttemptAt) {
    const delay = Date.parse(receipt.nextAttemptAt) - updated;
    const minimumDelay = Math.min(30_000 * (2 ** Math.max(receipt.attempt - 1, 0)), 5 * 60 * 1000);
    const maximumDelay = Math.min(minimumDelay * 2, 5 * 60 * 1000);
    if (delay < minimumDelay || delay > maximumDelay) errors.push('retry backoff not bounded monotonic');
  }
  if (['SUCCEEDED', 'SKIPPED_POLICY', 'TERMINAL_FAILED'].includes(receipt.state) && receipt.nextAttemptAt !== null) errors.push('terminal receipt schedules retry');
  if (receipt.state !== 'UNKNOWN_COMMIT' && (receipt.unknownProbeCount !== 0 || receipt.lastProbeAt !== null)) errors.push('non-unknown receipt carries probe state');
  if (receipt.nextAttemptAt && Date.parse(receipt.nextAttemptAt) > deadline) errors.push('next attempt exceeds deadline');
  if (receipt.state === 'LEASED') {
    if (!receipt.leaseOwner || !receipt.leaseExpiresAt || receipt.leaseVersion < 1) errors.push('leased receipt lacks valid owner/fence');
    if (Date.parse(receipt.leaseExpiresAt) <= updated) errors.push('leased receipt is not live at update');
    if (receipt.nextAttemptAt !== null || receipt.unknownProbeCount !== 0 || receipt.lastProbeAt !== null) errors.push('leased receipt carries retry/probe state');
  }
  if (receipt.reconciliationReceipt) {
    const reconciliation = receipt.reconciliationReceipt;
    if (attemptReconciliationReceiptDigest(reconciliation) !== reconciliation.receiptDigest) errors.push('attempt reconciliation receipt digest mismatch');
    if (reconciliation.sink !== receipt.sink || reconciliation.idempotencyKey !== receipt.idempotencyKey || reconciliation.outcome !== receipt.state || attemptReconciliationOutcomeDigest(receipt, reconciliation) !== reconciliation.outcomeDigest) errors.push('attempt reconciliation receipt binding mismatch');
    if (!['SUCCEEDED', 'TERMINAL_FAILED'].includes(receipt.state)) errors.push('attempt reconciliation carried by non-terminal outcome');
  }
  const legalPrevious = { PENDING: [null], LEASED: ['PENDING', 'RETRYABLE'], SUCCEEDED: ['LEASED', 'UNKNOWN_COMMIT'], SKIPPED_POLICY: ['PENDING', 'LEASED'], RETRYABLE: ['LEASED'], TERMINAL_FAILED: ['LEASED', 'RETRYABLE', 'UNKNOWN_COMMIT'], UNKNOWN_COMMIT: ['LEASED', 'UNKNOWN_COMMIT'] };
  if (!legalPrevious[receipt.state]?.includes(receipt.previousState)) errors.push('illegal receipt transition');
  return errors;
}

const coverageClockReceiptPayload = (clock) => jcs({ orgId: clock.orgId, clockId: clock.clockId, asOf: clock.asOf, issuedAt: clock.issuedAt, nonce: clock.nonce, policyVersion: clock.policyVersion, authorityPolicyDigest: clock.authorityPolicyDigest, authorityKeyId: clock.authorityKeyId });
function validateCoverageClock(clock, authority, trustedAuthorityDigest, secretConfig = {}) {
  const errors = [];
  if (!authority) return ['coverage clock authority missing'];
  const authoritySchemaErrors = validateJsonSchema(schemas.coverageClockAuthority, authority);
  if (authoritySchemaErrors.length) errors.push('coverage clock authority schema invalid');
  if (digestWithout(authority, 'policyDigest') !== authority.policyDigest) errors.push('coverage clock authority digest mismatch');
  if (!trustedAuthorityDigest || authority.policyDigest !== trustedAuthorityDigest) errors.push('coverage clock authority not deployment trusted');
  const secret = secretConfig.secretsByKeyId?.[clock.authorityKeyId];
  if (clock.orgId !== authority.orgId || clock.authorityPolicyDigest !== authority.policyDigest || clock.authorityKeyId !== authority.keyId || !secret) errors.push('coverage clock authority binding mismatch');
  else if (!constantTimeHexEqual(clock.authorityReceiptMacHex, hmacHex(secret, coverageClockReceiptPayload(clock)))) errors.push('coverage clock authority receipt invalid');
  const asOf = Date.parse(clock.asOf), issuedAt = Date.parse(clock.issuedAt), validFrom = Date.parse(authority.validFrom), validUntil = Date.parse(authority.validUntil);
  if (![asOf, issuedAt, validFrom, validUntil].every(Number.isFinite) || issuedAt < validFrom || issuedAt > validUntil || asOf < issuedAt || asOf - issuedAt > authority.maximumIssuedAtSkewSeconds * 1000 || asOf - issuedAt > authority.replayWindowSeconds * 1000) errors.push('coverage clock authority chronology invalid');
  return errors;
}

function validateCoverage(coverage, trustedCoverageKeyIds = [], trustedOrgId = null, evaluationClock = null, clockAuthority = null, trustedClockAuthorityDigest = null, clockSecretConfig = {}) {
  const schemaErrors = validateJsonSchema(schemas.coverage, coverage);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema coverage ${error}`)] : [];
  if (coverageSnapshotDigest(coverage) !== coverage.snapshotDigest) errors.push('snapshotDigest mismatch');
  if (!evaluationClock) errors.push('coverage evaluation clock missing');
  else {
    const clockSchemaErrors = validateJsonSchema(schemas.coverageClock, evaluationClock);
    if (clockSchemaErrors.length) errors.push('coverage evaluation clock schema invalid', ...clockSchemaErrors.map((error) => `schema coverageClock ${error}`));
    errors.push(...validateCoverageClock(evaluationClock, clockAuthority, trustedClockAuthorityDigest, clockSecretConfig));
    if (digestWithout(evaluationClock, 'clockDigest') !== evaluationClock.clockDigest) errors.push('coverage evaluation clock digest mismatch');
    if (evaluationClock.orgId !== coverage.orgId || evaluationClock.clockDigest !== coverage.evaluationClockDigest || evaluationClock.policyVersion !== coverage.freshness.policyVersion || evaluationClock.asOf !== coverage.freshness.evaluatedAsOf) errors.push('coverage evaluation clock binding mismatch');
    const asOf = Date.parse(evaluationClock.asOf), generated = Date.parse(coverage.generatedAt), cutoff = Date.parse(coverage.cutoffAt);
    const snapshotAgeSeconds = Math.floor((asOf - generated) / 1000);
    const sourceLagSeconds = Math.floor((asOf - cutoff) / 1000);
    if (![asOf, generated, cutoff].every(Number.isFinite) || snapshotAgeSeconds < 0 || sourceLagSeconds < 0) errors.push('coverage evaluated with future or inconsistent clock');
    const expectedState = snapshotAgeSeconds <= evaluationClock.maxSnapshotAgeSeconds && sourceLagSeconds <= evaluationClock.maxSourceLagSeconds ? 'current' : 'stale';
    if (coverage.freshness.snapshotAgeSeconds !== snapshotAgeSeconds || coverage.freshness.sourceLagSeconds !== sourceLagSeconds || coverage.freshness.state !== expectedState) errors.push('coverage freshness reducer mismatch');
    if (expectedState !== 'current') errors.push('coverage snapshot stale at evaluation clock');
    const freshnessReceipt = sha256(jcs({ coverageSnapshotId: coverage.coverageSnapshotId, evaluationClockDigest: coverage.evaluationClockDigest, generatedAt: coverage.generatedAt, cutoffAt: coverage.cutoffAt, policyVersion: coverage.freshness.policyVersion, evaluatedAsOf: coverage.freshness.evaluatedAsOf, state: coverage.freshness.state, snapshotAgeSeconds: coverage.freshness.snapshotAgeSeconds, sourceLagSeconds: coverage.freshness.sourceLagSeconds }));
    if (coverage.freshness.receiptDigest !== freshnessReceipt) errors.push('coverage freshness receipt mismatch');
  }
  const enumerationReceiptDigest = sha256(jcs({ orgId: coverage.orgId, channels: coverage.channels, windowStart: coverage.windowStart, windowEnd: coverage.windowEnd, cutoffAt: coverage.cutoffAt, enumerationState: coverage.enumerationState, cursor: coverage.cursor, checkpointDigest: coverage.checkpointDigest, sourceIds: coverage.sourceIds, recordIds: coverage.recordIds, counts: coverage.counts, gaps: coverage.gaps, keyId: coverage.enumerationAuthority.keyId, policyVersion: coverage.enumerationAuthority.policyVersion }));
  if (enumerationReceiptDigest !== coverage.enumerationAuthority.receiptDigest || !trustedCoverageKeyIds.includes(coverage.enumerationAuthority.keyId)) errors.push('untrusted coverage enumeration receipt');
  if (!trustedOrgId || coverage.orgId !== trustedOrgId) errors.push('coverage enumeration org mismatch');
  if (sha256(jcs([...coverage.sourceIds].sort())) !== coverage.sourceDigest) errors.push('coverage source membership digest mismatch');
  if (sha256(jcs([...coverage.recordIds].sort())) !== coverage.recordSetDigest) errors.push('coverage record membership digest mismatch');
  if (Date.parse(coverage.windowEnd) < Date.parse(coverage.windowStart)) errors.push('coverage window inverted');
  if (Date.parse(coverage.cutoffAt) < Date.parse(coverage.windowEnd)) errors.push('coverage cutoff precedes window end');
  if (Date.parse(coverage.generatedAt) < Date.parse(coverage.cutoffAt)) errors.push('coverage generated before cutoff');
  const { discovered, processed, quarantined, unresolved, excluded } = coverage.counts;
  if (coverage.sourceIds.length !== discovered || coverage.recordIds.length !== processed) errors.push('coverage membership count mismatch');
  if (processed + quarantined + unresolved + excluded !== discovered) errors.push('coverage partition mismatch');
  if (coverage.enumerationState === 'complete' && (coverage.cursor !== null || unresolved !== 0 || coverage.gaps.some((gap) => gap.blocking))) errors.push('complete coverage has unresolved state');
  if (coverage.enumerationState === 'partial' && !coverage.cursor) errors.push('partial coverage lacks cursor');
  const gapIds = coverage.gaps.map((gap) => gap.gapId);
  if (!unique(gapIds)) errors.push('duplicate coverage gap');
  return [...new Set(errors)];
}

function validateIntent(intent, request, record, baseCrmProjection, currentCrmProjection = null) {
  const schemaErrors = validateJsonSchema(schemas.intent, intent);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema intent ${error}`)] : [];
  if (crmIntentDigest(intent) !== intent.intentDigest) errors.push('intentDigest mismatch');
  errors.push(...validateExactOperationBinding(intent));
  if (!intent.canonicalClaimId) errors.push('intent missing canonical claim');
  if (!intent.claimId) errors.push('intent missing claim version');
  if (!intent.evidenceRefs.length) errors.push('intent missing evidence');
  if (sha256(jcs(intent.proposedValue)) !== intent.proposedValueDigest) errors.push('proposedValueDigest mismatch');
  if (request) {
    for (const field of ['orgId', 'clientRequestId', 'requestDigest', 'canonicalMeetingId', 'recordVersion', 'recordDigest', 'canonicalClaimId', 'claimId', 'baseCrmVersion', 'baseCrmDigest', 'requestKind', 'operation', 'proposedValueDigest', 'idempotencyKey', 'submittedAt']) if (!jsonSetEqual([intent[field]], [request[field]])) errors.push('intent/request binding mismatch');
    for (const field of ['target', 'proposedValue', 'submittedBy']) if (jcs(intent[field]) !== jcs(request[field])) errors.push('intent/request binding mismatch');
    if (!jsonSetEqual(intent.evidenceRefs, request.evidenceRefs)) errors.push('intent/request binding mismatch');
  }
  if (record) {
    if (intent.orgId !== record.orgId || intent.canonicalMeetingId !== record.canonicalMeetingId || intent.recordVersion !== record.recordVersion || intent.recordDigest !== record.recordDigest) errors.push('intent/record binding mismatch');
    const claim = record.claims.find((item) => item.claimId === intent.claimId && item.canonicalClaimId === intent.canonicalClaimId);
    if (!claim || intent.evidenceRefs.some((ref) => !claim.evidenceRefs.includes(ref))) errors.push('intent claim/evidence binding mismatch');
  }
  if (baseCrmProjection && (intent.baseCrmVersion !== baseCrmProjection.sourceVersion || intent.baseCrmDigest !== baseCrmProjection.sourceDigest || intent.orgId !== baseCrmProjection.orgId)) errors.push('intent base CRM binding mismatch');
  if (intent.stateVersion === 1 && intent.previousIntentDigest !== null) errors.push('initial intent carries previous digest');
  if (intent.stateVersion > 1 && intent.previousIntentDigest === null) errors.push('versioned intent lacks previous digest');
  if (intent.state === 'accepted_pending' && (intent.authoritativeReadbackVersion !== null || intent.authoritativeReadbackDigest !== null || intent.rejectionCode !== null)) errors.push('pending intent carries terminal state');
  if (intent.state === 'unknown_commit' && (intent.authoritativeReadbackVersion !== null || intent.authoritativeReadbackDigest !== null || intent.rejectionCode !== null || intent.reconciliationReceipt !== null)) errors.push('unknown intent carries terminal reconciliation');
  if (intent.reconciliationReceipt) {
    const receipt = intent.reconciliationReceipt;
    if (reconciliationReceiptDigest(receipt) !== receipt.receiptDigest) errors.push('reconciliation receipt digest mismatch');
    if (receipt.orgId !== intent.orgId || receipt.intentId !== intent.intentId || receipt.requestDigest !== intent.requestDigest || receipt.unknownIntentDigest !== intent.previousIntentDigest || receipt.operation !== intent.operation || jcs(receipt.target) !== jcs(intent.target) || receipt.proposedValueDigest !== intent.proposedValueDigest || receipt.outcome !== intent.state || receipt.authoritativeReadbackVersion !== intent.authoritativeReadbackVersion || receipt.authoritativeReadbackDigest !== intent.authoritativeReadbackDigest) errors.push('reconciliation receipt binding mismatch');
    if (Date.parse(receipt.reconciledAt) < Date.parse(intent.acceptedAt) || Date.parse(receipt.reconciledAt) > Date.parse(intent.updatedAt)) errors.push('reconciliation receipt time invalid');
    if (currentCrmProjection && (receipt.authoritativeReadbackVersion !== currentCrmProjection.sourceVersion || receipt.authoritativeReadbackDigest !== currentCrmProjection.sourceDigest)) errors.push('reconciliation authoritative readback mismatch');
  }
  if (intent.state === 'applied') {
    if (!currentCrmProjection || intent.orgId !== currentCrmProjection.orgId || intent.authoritativeReadbackVersion !== currentCrmProjection.sourceVersion || intent.authoritativeReadbackDigest !== currentCrmProjection.sourceDigest) errors.push('applied intent readback binding mismatch');
    if (intent.requestKind === 'system_exact' && currentCrmProjection) {
      const collectionByType = { account: ['accounts', 'accountId'], contact: ['contacts', 'contactId'], engagement: ['engagements', 'engagementId'], interaction: ['interactions', 'interactionId'], lifecycle: ['lifecycleItems', 'lifecycleId'] };
      const binding = collectionByType[intent.target.entityType];
      const row = binding && currentCrmProjection[binding[0]].find((item) => item[binding[1]] === intent.target.entityId);
      if (!row) errors.push('applied intent target readback missing');
      else if (Object.entries(intent.proposedValue).some(([key, value]) => jcs(row[key]) !== jcs(value))) errors.push('applied intent readback content mismatch');
    }
  }
  if (['rejected', 'terminal_failed'].includes(intent.state) && !intent.rejectionCode) errors.push('terminal intent lacks rejection code');
  if (Date.parse(intent.acceptedAt) < Date.parse(intent.submittedAt)) errors.push('intent accepted before submission');
  return [...new Set(errors)];
}

function validateIntentTransition(previous, current) {
  const errors = [];
  const immutable = ['schemaVersion', 'orgId', 'intentId', 'clientRequestId', 'requestDigest', 'canonicalMeetingId', 'recordVersion', 'recordDigest', 'canonicalClaimId', 'claimId', 'baseCrmVersion', 'baseCrmDigest', 'requestKind', 'operation', 'target', 'proposedValue', 'proposedValueDigest', 'evidenceRefs', 'idempotencyKey', 'submittedAt', 'acceptedAt', 'submittedBy'];
  for (const field of immutable) if (jcs(previous[field]) !== jcs(current[field])) errors.push('intent transition immutable field drift');
  if (current.stateVersion !== previous.stateVersion + 1 || current.previousIntentDigest !== previous.intentDigest || Date.parse(current.updatedAt) < Date.parse(previous.updatedAt)) errors.push('intent transition lineage mismatch');
  const legal = { accepted_pending: ['applied', 'rejected', 'unknown_commit', 'terminal_failed'], unknown_commit: ['applied', 'rejected', 'terminal_failed'] };
  if (!legal[previous.state]?.includes(current.state)) errors.push('illegal intent state transition');
  if (previous.state === 'unknown_commit') {
    if (!current.reconciliationReceipt || !current.authoritativeReadbackVersion || !current.authoritativeReadbackDigest) errors.push('UNKNOWN_COMMIT exit lacks authoritative reconciliation');
    else if (current.reconciliationReceipt.unknownIntentDigest !== previous.intentDigest || current.reconciliationReceipt.outcome !== current.state || current.reconciliationReceipt.requestDigest !== current.requestDigest || current.reconciliationReceipt.receiptDigest !== reconciliationReceiptDigest(current.reconciliationReceipt)) errors.push('UNKNOWN_COMMIT reconciliation transition mismatch');
  } else if (current.reconciliationReceipt !== null) {
    errors.push('non-UNKNOWN transition carries reconciliation receipt');
  }
  return [...new Set(errors)];
}

function validateIntentRequest(request) {
  const schemaErrors = validateJsonSchema(schemas.intentRequest, request);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema intentRequest ${error}`)] : [];
  if (crmIntentRequestDigest(request) !== request.requestDigest) errors.push('requestDigest mismatch');
  errors.push(...validateExactOperationBinding(request));
  if (sha256(jcs(request.proposedValue)) !== request.proposedValueDigest) errors.push('proposedValueDigest mismatch');
  if (request.requestKind === 'system_exact' && !request.submittedBy.subjectId.startsWith('service:')) errors.push('system exact request lacks service attribution');
  if (request.requestKind === 'user_proposal' && request.submittedBy.subjectId.startsWith('service:')) errors.push('user proposal lacks user attribution');
  return [...new Set(errors)];
}

function validateCrmDomainClosure() {
  const requestOperations = schemas.intentRequest.properties.operation.enum;
  const durableOperations = schemas.intent.properties.operation.enum;
  const embeddedOperations = schemas.delivery.$defs.crmIntentState.properties.operation.enum;
  const durableStates = schemas.intent.properties.state.enum;
  const embeddedStates = schemas.delivery.$defs.crmIntentState.properties.state.enum;
  const writeSetOperations = schemas.writeSet.$defs.expectedWrite.properties.operation.enum;
  const writeSetStates = schemas.writeSet.$defs.expectedWrite.properties.state.enum;
  const errors = [];
  for (const [label, domain] of [['request operation', requestOperations], ['durable operation', durableOperations], ['embedded operation', embeddedOperations], ['write-set operation', writeSetOperations]]) if (!jsonSetEqual(domain, CRM_ALLOWED_OPERATIONS)) errors.push(`CRM ${label} domain not closed`);
  for (const [label, domain] of [['durable state', durableStates], ['embedded state', embeddedStates], ['write-set state', writeSetStates]]) if (!jsonSetEqual(domain, CRM_DURABLE_STATES)) errors.push(`CRM ${label} domain not closed`);
  return errors;
}

function validateCrmProjection(projection) {
  const schemaErrors = validateJsonSchema(schemas.crmProjection, projection);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema crmProjection ${error}`)] : [];
  if (crmProjectionDigest(projection) !== projection.projectionDigest) errors.push('projectionDigest mismatch');
  for (const [kind, idField] of [['accounts', 'accountId'], ['contacts', 'contactId'], ['engagements', 'engagementId'], ['opportunities', 'opportunityId'], ['interactions', 'interactionId'], ['lifecycleItems', 'lifecycleId']]) {
    if (!unique(projection[kind].map((item) => item[idField]))) errors.push(`duplicate CRM ${kind}`);
    for (const item of projection[kind]) if (digestWithout(item, 'digest') !== item.digest) errors.push(`CRM ${kind} row digest mismatch`);
  }
  if (!unique(projection.interactions.map((item) => item.canonicalMeetingId))) errors.push('duplicate CRM interaction canonical meeting');
  if (!unique(projection.lifecycleItems.map((item) => item.canonicalClaimId))) errors.push('duplicate CRM lifecycle canonical claim');
  const accounts = new Set(projection.accounts.map((item) => item.accountId));
  const contacts = new Set(projection.contacts.map((item) => item.contactId));
  const engagements = new Set(projection.engagements.map((item) => item.engagementId));
  for (const item of projection.contacts) if (item.accountId !== null && !accounts.has(item.accountId)) errors.push('dangling CRM contact account');
  for (const item of projection.engagements) if (!accounts.has(item.accountId)) errors.push('dangling CRM engagement account');
  for (const item of projection.opportunities) if (!accounts.has(item.accountId) || (item.engagementId !== null && !engagements.has(item.engagementId))) errors.push('dangling CRM opportunity reference');
  for (const item of projection.interactions) {
    if (item.accountIds.some((id) => !accounts.has(id)) || item.contactIds.some((id) => !contacts.has(id)) || item.engagementIds.some((id) => !engagements.has(id))) errors.push('dangling CRM interaction reference');
  }
  const sourceDigest = sha256(jcs({ accounts: projection.accounts, contacts: projection.contacts, engagements: projection.engagements, opportunities: projection.opportunities, interactions: projection.interactions, lifecycleItems: projection.lifecycleItems }));
  if (sourceDigest !== projection.sourceDigest) errors.push('CRM sourceDigest mismatch');
  return [...new Set(errors)];
}

function validateCrmProjectionTransition(previous, current) {
  const errors = [];
  if (previous.orgId !== current.orgId) errors.push('CRM projection transition org mismatch');
  const stable = (priorRows, currentRows, canonicalField, idField, label) => {
    const prior = new Map(priorRows.map((item) => [item[canonicalField], item[idField]]));
    for (const item of currentRows) if (prior.has(item[canonicalField]) && prior.get(item[canonicalField]) !== item[idField]) errors.push(`CRM ${label} stable identity changed`);
  };
  stable(previous.interactions, current.interactions, 'canonicalMeetingId', 'interactionId', 'interaction');
  stable(previous.lifecycleItems, current.lifecycleItems, 'canonicalClaimId', 'lifecycleId', 'lifecycle');
  stable(previous.lifecycleItems, current.lifecycleItems, 'lifecycleId', 'canonicalClaimId', 'lifecycle reverse');
  return [...new Set(errors)];
}

function identityDecisionDigest(override) {
  return sha256(jcs({ orgId: override.orgId, overrideId: override.overrideId, overrideVersion: override.overrideVersion, supersedesOverrideDigest: override.supersedesOverrideDigest, sourceIds: [...override.sourceIds].sort(), canonicalSourceId: override.canonicalSourceId, reason: override.reason, selectionPolicyVersion: override.selectionPolicyVersion, kind: override.authority.kind, actorId: override.authority.actorId, policyVersion: override.authority.policyVersion, decidedAt: override.authority.decidedAt }));
}

function validateIdentityOverride(override, authorityRoot) {
  const schemaErrors = validateJsonSchema(schemas.identityOverride, override);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema identityOverride ${error}`)] : [];
  if (identityOverrideDigest(override) !== override.overrideDigest) errors.push('overrideDigest mismatch');
  if (!override.sourceIds.includes(override.canonicalSourceId)) errors.push('override canonical source missing');
  if (identityDecisionDigest(override) !== override.authority.decisionDigest) errors.push('identity decisionDigest mismatch');
  if (!authorityRoot || authorityRoot.orgId !== override.orgId || !authorityRoot.identityPolicies.some((policy) => policy.kind === override.authority.kind && policy.actorId === override.authority.actorId && policy.policyVersion === override.authority.policyVersion)) errors.push('untrusted identity authority');
  if (!authorityRoot?.authorizedIdentityDecisionDigests.includes(override.authority.decisionDigest)) errors.push('identity decision not authorized by trust root');
  return [...new Set(errors)];
}

function validateAuthorityRoot(root, expectedTrustedRootDigest) {
  const schemaErrors = validateJsonSchema(schemas.authorityRoot, root);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema authorityRoot ${error}`)] : [];
  if (authorityRootDigest(root) !== root.rootDigest) errors.push('authority rootDigest mismatch');
  if (!expectedTrustedRootDigest || root.rootDigest !== expectedTrustedRootDigest) errors.push('authority root not deployment trusted');
  if (!unique(root.authorizedClaimDecisionDigests) || !unique(root.authorizedIdentityDecisionDigests)) errors.push('duplicate authorized decision digest');
  if (!unique(root.relayInternalAuthKeyIds) || !unique(root.coverageEnumeratorKeyIds)) errors.push('duplicate runtime authority key');
  if (!unique(root.identityPolicies.map((policy) => `${policy.kind}:${policy.actorId}:${policy.policyVersion}`))) errors.push('duplicate identity authority policy');
  return [...new Set(errors)];
}

function validateAuthorityRegistry(registry) {
  const schemaErrors = validateJsonSchema(schemas.authorityRegistry, registry);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema authorityRegistry ${error}`)] : [];
  if (authorityRegistryDigest(registry) !== registry.registryDigest) errors.push('registryDigest mismatch');
  if (!unique(registry.policies.map((policy) => `${policy.kind}:${policy.actorId}:${policy.policyVersion}`))) errors.push('duplicate authority policy');
  return [...new Set(errors)];
}

function candidateSetDigest(record) {
  const candidates = record.claims.map((claim) => ({ claimId: claim.claimId, canonicalClaimId: claim.canonicalClaimId, identityBasisDigest: claim.identityBasisDigest, candidateContentDigest: claim.candidateContentDigest, evidenceRefs: [...claim.evidenceRefs].sort() })).sort((left, right) => left.claimId.localeCompare(right.claimId));
  return sha256(jcs(candidates));
}

function validateDispositionSet(set, record = null) {
  const schemaErrors = validateJsonSchema(schemas.dispositionSet, set);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema dispositionSet ${error}`)] : [];
  if (dispositionSetDigest(set) !== set.dispositionSetDigest) errors.push('dispositionSetDigest mismatch');
  if (!unique(set.dispositions.map((item) => item.claimId))) errors.push('duplicate claim disposition');
  for (const decision of set.dispositions) {
    const expected = record ? claimDecisionDigest(record, decision) : digestWithout(decision, 'decisionDigest');
    if (expected !== decision.decisionDigest) errors.push('decisionDigest mismatch');
  }
  return [...new Set(errors)];
}

function validateDispositionJoin(record, set, registry, authorityRoot, trustedAuthorityRootDigest) {
  const errors = [...validateDispositionSet(set, record), ...validateAuthorityRegistry(registry), ...validateAuthorityRoot(authorityRoot, trustedAuthorityRootDigest)];
  if (authorityRoot.claimRegistryDigest !== registry.registryDigest || authorityRoot.orgId !== record.orgId || registry.orgId !== record.orgId) errors.push('authority root/registry binding mismatch');
  if (set.dispositionSetDigest !== record.claimDispositionSetDigest || set.candidateSetDigest !== record.candidateSetDigest || set.candidateSetDigest !== candidateSetDigest(record) || set.authorityRegistryDigest !== record.claimAuthorityRegistryDigest || registry.registryDigest !== record.claimAuthorityRegistryDigest) errors.push('disposition authority binding mismatch');
  if (set.canonicalMeetingId !== record.canonicalMeetingId || set.recordVersion !== record.recordVersion || set.orgId !== record.orgId) errors.push('disposition record identity mismatch');
  const decisions = new Map(set.dispositions.map((decision) => [decision.claimId, decision]));
  const policies = new Map(registry.policies.map((policy) => [`${policy.kind}:${policy.actorId}:${policy.policyVersion}`, policy]));
  for (const claim of record.claims) {
    const decision = decisions.get(claim.claimId);
    if (claim.disposition.state === 'proposed') {
      if (decision || claim.disposition.authority !== null) errors.push('proposed claim joined to authority');
      continue;
    }
    if (!decision) { errors.push('accepted claim lacks independent disposition'); continue; }
    const evidenceSetDigest = sha256(jcs([...claim.evidenceRefs].sort()));
    const evidenceLineageDigest = claimEvidenceLineageDigest(record, claim);
    if (decision.orgId !== record.orgId || decision.canonicalMeetingId !== record.canonicalMeetingId || decision.recordVersion !== record.recordVersion || decision.canonicalClaimId !== claim.canonicalClaimId || decision.identityBasisDigest !== claim.identityBasisDigest || decision.identityBasisDigest !== claimIdentityBasisDigest(record, claim) || decision.evidenceLineageDigest !== evidenceLineageDigest || decision.candidateContentDigest !== claim.candidateContentDigest || decision.evidenceSetDigest !== evidenceSetDigest || decision.state !== claim.disposition.state || !jsonSetEqual(Object.entries(decision.authorizedMaterialization).filter(([,value]) => value).map(([key]) => key), Object.entries(claim.materialization).filter(([,value]) => value).map(([key]) => key))) errors.push('claim disposition content mismatch');
    const policy = policies.get(`${decision.kind}:${decision.actorId}:${decision.policyVersion}`);
    if (!policy) errors.push('untrusted disposition authority');
    else if (!policy.semanticClasses.includes(claim.semanticClass) || !policy.claimKinds.includes(claim.claimKind) || !policy.dispositionStates.includes(decision.state) || Object.entries(decision.authorizedMaterialization).some(([key, value]) => value && !policy.allowedMaterialization[key])) errors.push('disposition authority scope violation');
    const authority = claim.disposition.authority;
    if (!authority || authority.kind !== decision.kind || authority.actorId !== decision.actorId || authority.policyVersion !== decision.policyVersion || authority.decisionDigest !== decision.decisionDigest || authority.decidedAt !== decision.decidedAt) errors.push('embedded disposition mismatch');
    if (!authorityRoot.authorizedClaimDecisionDigests.includes(decision.decisionDigest)) errors.push('claim decision not authorized by trust root');
  }
  return [...new Set(errors)];
}

function validateReplicationAck(ack) {
  const schemaErrors = validateJsonSchema(schemas.replicationAck, ack);
  const errors = schemaErrors.length ? ['schema validation failed', ...schemaErrors.map((error) => `schema replicationAck ${error}`)] : [];
  if (digestWithout(ack, 'ackDigest') !== ack.ackDigest) errors.push('ackDigest mismatch');
  return [...new Set(errors)];
}

function validateReplicationAckBinding(ack, delivery, briefsReadback) {
  const errors = validateReplicationAck(ack);
  if (ack.orgId !== delivery.orgId || ack.canonicalMeetingId !== delivery.canonicalMeetingId || ack.recordDigest !== delivery.recordDigest || ack.manifestRevision !== delivery.manifestRevision || ack.manifestDigest !== delivery.manifestDigest) errors.push('replication ack binding mismatch');
  if (!briefsReadback || ack.readbackDigest !== briefsReadback.readbackDigest || ack.storedProjectionVersion !== briefsReadback.storedProjectionVersion || ack.storedProjectionDigest !== briefsReadback.storedProjectionDigest) errors.push('replication ack/readback binding mismatch');
  return [...new Set(errors)];
}

const EXPECTED_REQUEST_FIELDS = ['clientRequestId', 'requestDigest', 'canonicalClaimId', 'claimId', 'requestKind', 'operation', 'target', 'proposedValueDigest', 'evidenceRefs', 'idempotencyKey'];
const EXPECTED_INTENT_FIELDS = [...EXPECTED_REQUEST_FIELDS, 'intentId', 'intentDigest', 'state'];
const requestIdentity = (value) => `${value.clientRequestId}:${value.requestDigest}`;
const intentIdentity = (value) => `${value.intentId}:${value.intentDigest}`;
const exactIdentitySet = (label, expected, actual) => {
  const errors = [];
  if (!unique(expected)) errors.push(`CRM expected write set duplicate ${label} identity`);
  if (!unique(actual)) errors.push(`CRM supplied ${label} set duplicate identity`);
  if (!jsonSetEqual(expected, actual)) errors.push(`CRM ${label} set mismatch`);
  return errors;
};

function validateCrmWriteSet(writeSet, record = null) {
  if (!writeSet) return ['CRM expected write set missing'];
  const schemaErrors = validateJsonSchema(schemas.writeSet, writeSet);
  const errors = schemaErrors.length ? ['CRM expected write set schema validation failed', ...schemaErrors.map((error) => `schema writeSet ${error}`)] : [];
  if (crmWriteSetDigest(writeSet) !== writeSet.writeSetDigest) errors.push('CRM writeSetDigest mismatch');
  if (!Array.isArray(writeSet.expectedWrites) || writeSet.expectedWrites.length === 0) errors.push('CRM expected write set empty');
  if (record && (writeSet.orgId !== record.orgId || writeSet.canonicalMeetingId !== record.canonicalMeetingId || writeSet.recordVersion !== record.recordVersion || writeSet.recordDigest !== record.recordDigest)) errors.push('CRM write set/record binding mismatch');
  if (Array.isArray(writeSet.expectedWrites)) {
    if (!unique(writeSet.expectedWrites.map((item) => item.clientRequestId)) || !unique(writeSet.expectedWrites.map(requestIdentity))) errors.push('CRM expected write set duplicate request identity');
    if (!unique(writeSet.expectedWrites.map((item) => item.intentId)) || !unique(writeSet.expectedWrites.map(intentIdentity))) errors.push('CRM expected write set duplicate durable intent identity');
    const idempotencyKeys = writeSet.expectedWrites.map((item) => item.idempotencyKey);
    if (!unique(idempotencyKeys)) errors.push('CRM expected write set duplicate idempotency identity');
    for (const expected of writeSet.expectedWrites) {
      errors.push(...validateExactOperationBinding(expected));
      if (!CRM_ALLOWED_OPERATIONS.includes(expected.operation)) errors.push('CRM write set operation domain mismatch');
      if (!CRM_DURABLE_STATES.includes(expected.state)) errors.push('CRM write set state domain mismatch');
    }
  }
  return [...new Set(errors)];
}

function validateCrmWriteSetArtifacts(artifacts, writeSet, record, baseCrmProjection, currentCrmProjection) {
  if (!artifacts) return ['CRM write set artifacts missing'];
  const schemaErrors = validateJsonSchema(schemas.writeSetArtifacts, artifacts);
  const errors = schemaErrors.length ? ['CRM write set artifacts schema validation failed', ...schemaErrors.map((error) => `schema writeSetArtifacts ${error}`)] : [];
  if (!writeSet || artifacts.writeSetId !== writeSet.writeSetId || artifacts.orgId !== writeSet.orgId || artifacts.canonicalMeetingId !== writeSet.canonicalMeetingId || artifacts.recordVersion !== writeSet.recordVersion || artifacts.recordDigest !== writeSet.recordDigest) errors.push('CRM write set artifact collection binding mismatch');
  if (record && (artifacts.orgId !== record.orgId || artifacts.canonicalMeetingId !== record.canonicalMeetingId || artifacts.recordVersion !== record.recordVersion || artifacts.recordDigest !== record.recordDigest)) errors.push('CRM write set artifacts/record binding mismatch');
  for (const request of artifacts.requests ?? []) errors.push(...validateIntentRequest(request));
  for (const intent of artifacts.intents ?? []) {
    const request = (artifacts.requests ?? []).find((item) => requestIdentity(item) === requestIdentity(intent));
    errors.push(...validateIntent(intent, request, record, baseCrmProjection, currentCrmProjection));
  }
  return [...new Set(errors)];
}

function validateExactWriteSetJoin(writeSet, delivery, crmIntentRequests, crmIntents, record, baseCrmProjection, crmProjection) {
  const errors = validateCrmWriteSet(writeSet, record);
  if (!writeSet || !Array.isArray(writeSet.expectedWrites)) return errors;
  if (delivery.crm.writeSetId !== writeSet.writeSetId || delivery.crm.writeSetDigest !== writeSet.writeSetDigest) errors.push('CRM delivery/write set binding mismatch');
  const expectedRequestIds = writeSet.expectedWrites.map(requestIdentity);
  const expectedIntentIds = writeSet.expectedWrites.map(intentIdentity);
  if (!unique(crmIntentRequests.map((item) => item.clientRequestId))) errors.push('CRM supplied request set duplicate identity');
  if (!unique(crmIntents.map((item) => item.intentId))) errors.push('CRM supplied durable intent set duplicate identity');
  if (!unique(delivery.crm.writeIntents.map((item) => item.intentId))) errors.push('CRM supplied delivery intent set duplicate identity');
  errors.push(...exactIdentitySet('request', expectedRequestIds, crmIntentRequests.map(requestIdentity)));
  errors.push(...exactIdentitySet('durable intent', expectedIntentIds, crmIntents.map(intentIdentity)));
  errors.push(...exactIdentitySet('delivery intent', expectedIntentIds, delivery.crm.writeIntents.map(intentIdentity)));
  for (const expected of writeSet.expectedWrites) {
    const request = crmIntentRequests.find((item) => requestIdentity(item) === requestIdentity(expected));
    const durable = crmIntents.find((item) => intentIdentity(item) === intentIdentity(expected));
    const embedded = delivery.crm.writeIntents.find((item) => intentIdentity(item) === intentIdentity(expected));
    if (!request || !durable || !embedded) continue;
    for (const field of EXPECTED_REQUEST_FIELDS) if (jcs(request[field]) !== jcs(expected[field])) errors.push('CRM expected/request field mismatch');
    for (const field of EXPECTED_INTENT_FIELDS) {
      if (jcs(durable[field]) !== jcs(expected[field])) errors.push('CRM expected/durable field mismatch');
      if (jcs(embedded[field]) !== jcs(expected[field])) errors.push('CRM expected/delivery field mismatch');
    }
    errors.push(...validateIntent(durable, request, record, baseCrmProjection, crmProjection));
  }
  return [...new Set(errors)];
}

function validateSystemJoin({ record, delivery, crmProjection, baseCrmProjection, crmWriteSet, crmIntentRequests = [], crmIntents = [], replicationAck, briefsReadback, dispositionSet, authorityRegistry, authorityRoot, trustedAuthorityRootDigest, identityOverride, priorPaReceipt = null, previousRecord = null }) {
  if (!record || !delivery || !crmProjection || !replicationAck || !briefsReadback) return ['system join missing required artifact'];
  const errors = [
    ...validateRecord(record, dispositionSet, authorityRegistry, authorityRoot, trustedAuthorityRootDigest, identityOverride, crmProjection),
    ...validateDelivery(delivery),
    ...validateCrmProjection(crmProjection),
    ...validateBriefsReadback(briefsReadback, record, delivery),
    ...validateReplicationAckBinding(replicationAck, delivery, briefsReadback),
    ...validatePaReceiptBinding(delivery.paDeliveryReceipt, delivery, record, priorPaReceipt, previousRecord),
    ...validateExactWriteSetJoin(crmWriteSet, delivery, crmIntentRequests, crmIntents, record, baseCrmProjection, crmProjection),
  ];
  if (new Set([record.orgId, delivery.orgId, crmProjection.orgId, replicationAck.orgId]).size !== 1) errors.push('cross-artifact org mismatch');
  if (delivery.canonicalMeetingId !== record.canonicalMeetingId || delivery.recordVersion !== record.recordVersion || delivery.recordDigest !== record.recordDigest) errors.push('delivery/record binding mismatch');
  if (replicationAck.canonicalMeetingId !== record.canonicalMeetingId || replicationAck.recordDigest !== record.recordDigest) errors.push('ack/record binding mismatch');
  if (delivery.crm.projectionVersion !== crmProjection.projectionVersion || delivery.crm.projectionDigest !== crmProjection.projectionDigest || delivery.crm.sourceVersion !== crmProjection.sourceVersion || delivery.crm.sourceDigest !== crmProjection.sourceDigest) errors.push('delivery/CRM projection binding mismatch');
  const interaction = crmProjection.interactions.find((item) => item.interactionId === delivery.crm.interactionId);
  if (!interaction || interaction.canonicalMeetingId !== record.canonicalMeetingId || interaction.recordDigest !== record.recordDigest) errors.push('CRM interaction join missing');
  const crmReceipt = delivery.upstreamReceipts.find((item) => item.sink === 'crm_interaction');
  if (!interaction || !crmReceipt || crmReceipt.state !== 'SUCCEEDED' || crmReceipt.providerId !== interaction.interactionId || crmReceipt.readbackVersion !== interaction.version || crmReceipt.readbackObjectDigest !== interaction.digest) errors.push('CRM receipt/readback join mismatch');
  const lifecycleItems = crmProjection.lifecycleItems.filter((item) => item.recordDigest === record.recordDigest);
  const expectedLifecycle = Object.values(record.lifecycle).flat();
  if (lifecycleItems.length !== expectedLifecycle.length || expectedLifecycle.some((id) => !lifecycleItems.some((item) => item.canonicalClaimId === id))) errors.push('CRM lifecycle join mismatch');
  const lifecycleReceipt = delivery.upstreamReceipts.find((item) => item.sink === 'lifecycle_projection');
  const lifecycleDigest = sha256(jcs(lifecycleItems.map((item) => item.digest).sort()));
  if (!lifecycleReceipt || lifecycleReceipt.state !== 'SUCCEEDED' || lifecycleReceipt.readbackObjectDigest !== lifecycleDigest) errors.push('lifecycle receipt/readback join mismatch');
  const draftReceipt = delivery.upstreamReceipts.find((item) => item.sink === 'followup_draft');
  const draftDigest = sha256(jcs({ draftId: delivery.followUpDraft.draftId, subject: delivery.followUpDraft.subject, bodyDigest: delivery.followUpDraft.bodyDigest }));
  if (draftReceipt?.state === 'SUCCEEDED' && draftReceipt.readbackObjectDigest !== draftDigest) errors.push('draft receipt/readback join mismatch');
  const briefsReceipt = delivery.upstreamReceipts.find((item) => item.sink === 'briefs_projection');
  if (!briefsReceipt || briefsReceipt.state !== 'SUCCEEDED' || briefsReceipt.readbackVersion !== replicationAck.storedProjectionVersion || briefsReceipt.readbackObjectDigest !== replicationAck.storedProjectionDigest) errors.push('Briefs receipt/replication join mismatch');
  if (delivery.crm.writeIntents.some((item) => item.requestKind === 'system_exact' && item.state !== 'applied')) errors.push('CRM exact intent not applied');
  for (const embedded of delivery.crm.writeIntents) {
    const durable = crmIntents.find((item) => item.intentId === embedded.intentId && item.intentDigest === embedded.intentDigest);
    const request = crmIntentRequests.find((item) => item.clientRequestId === embedded.clientRequestId && item.requestDigest === embedded.requestDigest);
    if (!durable || !request) { errors.push('CRM durable intent join missing'); continue; }
    for (const field of ['clientRequestId', 'requestDigest', 'canonicalClaimId', 'claimId', 'baseCrmVersion', 'baseCrmDigest', 'requestKind', 'operation', 'target', 'proposedValueDigest', 'evidenceRefs', 'idempotencyKey', 'submittedBy', 'state', 'authoritativeReadbackVersion', 'authoritativeReadbackDigest', 'rejectionCode']) if (jcs(embedded[field]) !== jcs(durable[field])) errors.push('delivery/durable intent binding mismatch');
  }
  return [...new Set(errors)];
}

function deriveSystemState(input) {
  const { record, delivery, crmProjection, replicationAck } = input;
  const joinErrors = validateSystemJoin(input);
  const upstreamSatisfied = delivery.upstreamReceipts.every((receipt) => receipt.state === 'SUCCEEDED' || (receipt.sink === 'followup_draft' && receipt.state === 'SKIPPED_POLICY'));
  const upstreamTerminalFailed = delivery.upstreamReceipts.some((receipt) => receipt.state === 'TERMINAL_FAILED');
  const upstreamUnknownCommit = delivery.upstreamReceipts.some((receipt) => receipt.state === 'UNKNOWN_COMMIT');
  const paSucceeded = delivery.paDeliveryReceipt?.state === 'SUCCEEDED' && ['normal_completion', 'correction'].includes(delivery.paDeliveryReceipt.notificationKind);
  const exceptionNotified = delivery.paDeliveryReceipt?.state === 'SUCCEEDED' && delivery.paDeliveryReceipt.notificationKind === 'terminal_exception';
  const paReconciliationRequired = delivery.paDeliveryReceipt?.state === 'UNKNOWN_COMMIT';
  const recordReady = joinErrors.length === 0;
  const crmReady = joinErrors.length === 0;
  const dashboardConverged = joinErrors.length === 0 && replicationAck?.state === 'SUCCEEDED';
  return {
    recordReady,
    crmReady,
    upstreamSatisfied,
    upstreamTerminalFailed,
    upstreamUnknownCommit,
    normalNotificationEligible: recordReady && crmReady && upstreamSatisfied && !upstreamTerminalFailed && !upstreamUnknownCommit && delivery.paDeliveryReceipt === null,
    paReconciliationRequired,
    exceptionNotified,
    notificationComplete: recordReady && crmReady && upstreamSatisfied && paSucceeded,
    dashboardConverged,
    overallComplete: recordReady && crmReady && upstreamSatisfied && paSucceeded && dashboardConverged,
    joinErrors,
  };
}

function validateRecordTransition(previous, current, previousOverride, currentOverride) {
  const errors = [];
  if (previous.orgId !== current.orgId || previous.canonicalMeetingId !== current.canonicalMeetingId) errors.push('record transition identity mismatch');
  if (current.recordVersion !== previous.recordVersion + 1 || current.previousRecordDigest !== previous.recordDigest) errors.push('record transition version gap');
  const previousClaims = new Map(previous.claims.map((claim) => [claim.claimId, claim]));
  const previousCanonical = new Map(previous.claims.map((claim) => [claim.canonicalClaimId, claim]));
  const currentCanonical = new Map(current.claims.map((claim) => [claim.canonicalClaimId, claim]));
  for (const claim of current.claims) {
    if (claim.supersedesClaimId) {
      const prior = previousClaims.get(claim.supersedesClaimId);
      if (!prior || prior.canonicalClaimId !== claim.canonicalClaimId) errors.push('record transition supersedes unknown claim');
    }
    const prior = previousCanonical.get(claim.canonicalClaimId);
    if (!prior) continue;
    if (claim.claimId === prior.claimId && claim.candidateContentDigest !== prior.candidateContentDigest) errors.push('record transition mutated immutable claim version');
    if (claim.claimId !== prior.claimId && claim.supersedesClaimId !== prior.claimId) errors.push('record transition missing claim supersession');
  }
  for (const claim of previous.claims.filter((item) => item.disposition.state === 'accepted')) if (!currentCanonical.has(claim.canonicalClaimId)) errors.push('record transition silently removed accepted claim');
  const currentSources = new Map(current.sourceObservations.map((source) => [source.sourceId, source]));
  const previousSourceIds = new Set(previous.sourceObservations.map((source) => source.sourceId));
  const immutableSourceEvidenceFields = ['provider', 'capturedAt', 'startedAt', 'transcriptState', 'transcriptDigest', 'evidenceDigest', 'lineageDigest', 'selectionPolicyVersion', 'segmentCount', 'normalizedWordCount', 'durationSeconds', 'evidenceArtifactCount', 'title'];
  for (const prior of previous.sourceObservations) {
    const next = currentSources.get(prior.sourceId);
    if (!next) { errors.push('record transition removed source observation'); continue; }
    if (immutableSourceEvidenceFields.some((field) => jcs(prior[field]) !== jcs(next[field]))) errors.push('record transition rewrote immutable source evidence');
    if (prior.state !== 'active' && jcs(prior) !== jcs(next)) errors.push('record transition mutated retired source tombstone');
    if (prior.state === 'active' && next.state !== 'active') {
      if (!next.tombstoneId || !next.supersededBy || previousSourceIds.has(next.supersededBy) || !currentSources.has(next.supersededBy)) errors.push('record transition source retirement lacks explicit new identity');
    }
    if (prior.state !== 'active' && next.state === 'active') errors.push('record transition resurrected retired source identity');
  }
  const priorTombstones = new Map(previous.sourceObservations.filter((source) => source.tombstoneId).map((source) => [source.tombstoneId, source.sourceId]));
  for (const source of current.sourceObservations.filter((item) => item.tombstoneId)) if (priorTombstones.has(source.tombstoneId) && priorTombstones.get(source.tombstoneId) !== source.sourceId) errors.push('record transition reassigned source tombstone');
  if (previousOverride?.overrideDigest !== currentOverride?.overrideDigest) {
    if (!previousOverride || !currentOverride || currentOverride.overrideId !== previousOverride.overrideId || currentOverride.overrideVersion !== previousOverride.overrideVersion + 1 || currentOverride.supersedesOverrideDigest !== previousOverride.overrideDigest) errors.push('identity override transition invalid');
  }
  return [...new Set(errors)];
}

function validateAttemptTransition(prior, receipt, label) {
  const errors = [];
  if (receipt.idempotencyKey !== prior.idempotencyKey || receipt.previousState !== prior.state) errors.push(`${label} receipt transition mismatch`);
  if (receipt.firstAttemptAt !== prior.firstAttemptAt || receipt.deadlineAt !== prior.deadlineAt) errors.push(`${label} attempt window mutated`);
  if (Date.parse(receipt.updatedAt) < Date.parse(prior.updatedAt)) errors.push(`${label} receipt time moved backward`);
  if (receipt.state === 'RETRYABLE') {
    if (prior.state !== 'LEASED' || receipt.attempt !== prior.attempt + 1) errors.push(`${label} retry outcome did not consume attempt`);
  } else if (receipt.attempt !== prior.attempt) {
    errors.push(`${label} attempt changed outside retry outcome`);
  }
  if (receipt.state === 'LEASED') {
    if (!['PENDING', 'RETRYABLE'].includes(prior.state) || receipt.leaseVersion !== prior.leaseVersion + 1) errors.push(`${label} lease acquisition lineage invalid`);
  } else if (receipt.leaseVersion !== prior.leaseVersion) {
    errors.push(`${label} lease fence changed without acquisition`);
  }
  if (prior.state === 'UNKNOWN_COMMIT') {
    if (receipt.state === 'UNKNOWN_COMMIT') {
      if (receipt.unknownProbeCount !== prior.unknownProbeCount + 1 || Date.parse(receipt.lastProbeAt) <= Date.parse(prior.lastProbeAt)) errors.push(`${label} UNKNOWN_COMMIT probes not monotonic`);
      if (receipt.reconciliationReceipt !== null) errors.push(`${label} unresolved UNKNOWN_COMMIT carries reconciliation`);
    } else {
      if (!['SUCCEEDED', 'TERMINAL_FAILED'].includes(receipt.state)) errors.push(`${label} UNKNOWN_COMMIT exit state invalid`);
      const reconciliation = receipt.reconciliationReceipt;
      if (!reconciliation) errors.push(`${label} UNKNOWN_COMMIT exit lacks authoritative reconciliation`);
      else if (reconciliation.unknownStateDigest !== attemptReceiptDigest(prior) || reconciliation.outcome !== receipt.state || reconciliation.sink !== prior.sink || reconciliation.idempotencyKey !== prior.idempotencyKey || attemptReconciliationReceiptDigest(reconciliation) !== reconciliation.receiptDigest || attemptReconciliationOutcomeDigest(receipt, reconciliation) !== reconciliation.outcomeDigest) errors.push(`${label} UNKNOWN_COMMIT reconciliation transition mismatch`);
    }
  } else if (receipt.reconciliationReceipt !== null) {
    errors.push(`${label} non-UNKNOWN transition carries reconciliation`);
  }
  return errors;
}

function validateDeliveryTransition(previous, current) {
  const errors = [];
  if (previous.orgId !== current.orgId || previous.canonicalMeetingId !== current.canonicalMeetingId || previous.recordDigest !== current.recordDigest) errors.push('delivery transition identity mismatch');
  if (current.manifestRevision !== previous.manifestRevision + 1 || current.previousManifestDigest !== previous.manifestDigest) errors.push('delivery transition revision gap');
  const priorBySink = new Map(previous.upstreamReceipts.map((receipt) => [receipt.sink, receipt]));
  for (const receipt of current.upstreamReceipts) {
    const prior = priorBySink.get(receipt.sink);
    if (!prior) { errors.push('delivery receipt transition mismatch'); continue; }
    if (['SUCCEEDED', 'SKIPPED_POLICY', 'TERMINAL_FAILED'].includes(prior.state)) {
      if (jcs(receipt) !== jcs(prior)) errors.push(receipt.state === prior.state ? 'terminal receipt carry-forward mutated' : 'terminal receipt reopened');
      continue;
    }
    errors.push(...validateAttemptTransition(prior, receipt, 'delivery'));
  }
  if (previous.paDeliveryReceipt?.state === 'SUCCEEDED' && !current.paDeliveryReceipt) errors.push('PA terminal receipt removed');
  if (previous.paDeliveryReceipt && current.paDeliveryReceipt) {
    const prior = previous.paDeliveryReceipt;
    const receipt = current.paDeliveryReceipt;
    if (prior.state === 'SUCCEEDED' && receipt.notificationKind === 'correction') {
      if (validateJsonSchema(schemas.delivery, current).length) errors.push('PA correction schema invalid');
      if (receipt.predecessorReceiptDigest !== prior.readbackDigest || receipt.predecessorSourceKey !== prior.sourceKey || receipt.predecessorProviderMessageId !== prior.providerMessageId || receipt.correctsProviderMessageId !== prior.providerMessageId) errors.push('PA correction predecessor transition mismatch');
      if (receipt.state !== 'SUCCEEDED' || receipt.previousState !== 'LEASED' || receipt.idempotencyKey === prior.idempotencyKey) errors.push('PA correction transition invalid');
    } else if (['SUCCEEDED', 'TERMINAL_FAILED'].includes(prior.state)) {
      if (jcs(receipt) !== jcs(prior)) errors.push('PA terminal receipt carry-forward mutated');
    } else {
      errors.push(...validateAttemptTransition(prior, receipt, 'PA'));
    }
  }
  return [...new Set(errors)];
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[Number.isInteger(Number(part)) ? Number(part) : part];
  const last = parts.at(-1);
  cursor[Number.isInteger(Number(last)) ? Number(last) : last] = value;
}

const record = load('meeting-record-v1.golden.json');
const observation = load('meeting-observation-v1.golden.json');
const firefliesVerificationConfig = load('fireflies-verification-config-v1.golden.json');
const firefliesVerificationConfigPin = load('fireflies-verification-config-pin-v1.json');
const processingFailure = load('meeting-processing-failure-v1.golden.json');
const preRecordIngressFailure = load('pre-record-ingress-failure-v1.golden.json');
const delivery = load('meeting-delivery-envelope-v1.golden.json');
const coverage = load('coverage-snapshot-v1.golden.json');
const coverageEvaluationClock = load('coverage-evaluation-clock-v1.golden.json');
const coverageClockAuthority = load('coverage-clock-authority-v1.golden.json');
const coverageClockAuthorityPin = load('coverage-clock-authority-pin-v1.json');
const coverageClockTestSecrets = load('coverage-clock-authority-v1.test-secrets.json');
const briefsOutput = load('briefs-meeting-intelligence-output-v1.golden.json');
const semanticEvaluation = load('semantic-evaluation-v1.golden.json');
const semanticDataset = load('semantic-evaluation-dataset-v1.golden.json');
const crmProjection = load('crm-projection-snapshot-v1.golden.json');
const baseCrmProjection = load('crm-projection-snapshot-v1.base.golden.json');
const intentRequest = load('crm-write-intent-request-v1.golden.json');
const pendingIntent = load('crm-write-intent-v1.pending.golden.json');
const intent = load('crm-write-intent-v1.golden.json');
const crmWriteSet = load('crm-write-set-v1.golden.json');
const crmWriteSetArtifacts = load('crm-write-set-artifacts-v1.golden.json');
const identityOverride = load('identity-override-v1.golden.json');
const authorityRegistry = load('claim-authority-registry-v1.golden.json');
const authorityRoot = load('meeting-authority-root-v1.golden.json');
const authorityRootPin = load('meeting-authority-root-pin-v1.json');
const dispositionSet = load('claim-disposition-set-v1.golden.json');
const replicationAck = load('projection-replication-ack-v1.golden.json');
const briefsReadback = load('briefs-projection-readback-v1.golden.json');
const firefliesVectors = load('fireflies-webhook-v2-test-vectors.json');
const firefliesTestSecrets = load('fireflies-webhook-v2.test-secrets.json');
const relayTestSecrets = load('relay-auth-v1.test-secrets.json');
const cases = load('meeting-contract-negative-cases.json').cases;
const validateGovernedCoverage = (value, clock = coverageEvaluationClock) => validateCoverage(value, authorityRoot.coverageEnumeratorKeyIds, authorityRoot.orgId, clock, coverageClockAuthority, runtimeTrustedCoverageClockAuthorityDigest, coverageClockTestSecrets);
const positiveErrors = [
  ...validateObservation(observation, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest),
  ...validateFirefliesVerificationConfig(firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest),
  ...validateProcessingFailure(processingFailure, observation),
  ...validatePreRecordIngressFailure(preRecordIngressFailure),
  ...validateBriefsOutput(briefsOutput, record, coverage, coverageEvaluationClock, [record], delivery),
  ...validateSemanticEvaluation(semanticEvaluation, semanticDataset),
  ...validateRecord(record, dispositionSet, authorityRegistry, authorityRoot, runtimeTrustedAuthorityRootDigest, identityOverride, crmProjection),
  ...validateDelivery(delivery),
  ...validateGovernedCoverage(coverage),
  ...validateCrmProjection(crmProjection),
  ...validateCrmProjection(baseCrmProjection),
  ...validateIntentRequest(intentRequest),
  ...validateIntent(pendingIntent, intentRequest, record, baseCrmProjection),
  ...validateIntent(intent, intentRequest, record, baseCrmProjection, crmProjection),
  ...validateIntentTransition(pendingIntent, intent),
  ...validateCrmWriteSet(crmWriteSet, record),
  ...validateCrmWriteSetArtifacts(crmWriteSetArtifacts, crmWriteSet, record, baseCrmProjection, crmProjection),
  ...validateCrmDomainClosure(),
  ...validateAuthorityRoot(authorityRoot, runtimeTrustedAuthorityRootDigest),
  ...validateIdentityOverride(identityOverride, authorityRoot),
  ...validateAuthorityRegistry(authorityRegistry),
  ...validateDispositionSet(dispositionSet),
  ...validateBriefsReadback(briefsReadback, record, delivery),
  ...validateReplicationAckBinding(replicationAck, delivery, briefsReadback),
  ...validateSystemJoin({ record, delivery, crmProjection, baseCrmProjection, crmWriteSet, crmIntentRequests: crmWriteSetArtifacts.requests, crmIntents: crmWriteSetArtifacts.intents, replicationAck, briefsReadback, dispositionSet, authorityRegistry, authorityRoot, trustedAuthorityRootDigest: runtimeTrustedAuthorityRootDigest, identityOverride }),
  ...validateFirefliesVectors(firefliesVectors, observation, firefliesTestSecrets),
];
if (authorityRootPin.runtimeTrustInput !== 'MEETING_AUTHORITY_ROOT_DIGEST' || authorityRootPin.authorityRootDigest !== runtimeTrustedAuthorityRootDigest) positiveErrors.push('runtime authority root pin mismatch');
if (firefliesVerificationConfigPin.runtimeTrustInput !== 'FIREFLIES_VERIFICATION_CONFIG_DIGEST' || firefliesVerificationConfigPin.verificationConfigDigest !== runtimeTrustedFirefliesVerificationConfigDigest) positiveErrors.push('runtime Fireflies verification config pin mismatch');
if (coverageClockAuthorityPin.runtimeTrustInput !== 'COVERAGE_CLOCK_AUTHORITY_DIGEST' || coverageClockAuthorityPin.authorityPolicyDigest !== runtimeTrustedCoverageClockAuthorityDigest) positiveErrors.push('runtime coverage clock authority pin mismatch');
if (delivery.crm.writeIntents.length !== crmWriteSet.expectedWrites.length || crmWriteSet.expectedWrites.some((expected) => !delivery.crm.writeIntents.some((embedded) => intentIdentity(embedded) === intentIdentity(expected)))) positiveErrors.push('delivery/write-set positive fixture incomplete');
const negativeResults = cases.map((testCase) => {
  const source = { observation, processingFailure, record, delivery, coverage, crmProjection, intentRequest, intent, identityOverride, authorityRegistry, authorityRoot, dispositionSet, replicationAck, briefsReadback }[testCase.fixture];
  if (!source) throw new Error(`unknown negative fixture: ${testCase.fixture}`);
  const fixture = clone(source);
  setPath(fixture, testCase.path, testCase.value);
  // Keep every semantic negative isolated from the digest guard. N-006 alone
  // intentionally exercises a stale digest; all other record mutations get a
  // valid digest so their named invariant must fail on its own.
  if (testCase.fixture === 'record' && testCase.path !== 'recordDigest') fixture.recordDigest = recordDigest(fixture);
  if (testCase.fixture === 'delivery' && testCase.path !== 'manifestDigest') fixture.manifestDigest = deliveryManifestDigest(fixture);
  if (testCase.fixture === 'coverage' && testCase.path !== 'snapshotDigest') fixture.snapshotDigest = coverageSnapshotDigest(fixture);
  if (testCase.fixture === 'intent' && testCase.path !== 'intentDigest') fixture.intentDigest = crmIntentDigest(fixture);
  if (testCase.fixture === 'intentRequest' && testCase.path !== 'requestDigest') fixture.requestDigest = crmIntentRequestDigest(fixture);
  if (testCase.fixture === 'crmProjection' && testCase.path !== 'projectionDigest') fixture.projectionDigest = crmProjectionDigest(fixture);
  if (testCase.fixture === 'identityOverride' && testCase.path !== 'overrideDigest') fixture.overrideDigest = identityOverrideDigest(fixture);
  if (testCase.fixture === 'authorityRegistry' && testCase.path !== 'registryDigest') fixture.registryDigest = authorityRegistryDigest(fixture);
  if (testCase.fixture === 'dispositionSet' && testCase.path !== 'dispositionSetDigest') fixture.dispositionSetDigest = dispositionSetDigest(fixture);
  if (testCase.fixture === 'replicationAck' && testCase.path !== 'ackDigest') fixture.ackDigest = digestWithout(fixture, 'ackDigest');
  if (testCase.fixture === 'authorityRoot' && testCase.path !== 'rootDigest') fixture.rootDigest = authorityRootDigest(fixture);
  if (testCase.fixture === 'briefsReadback' && testCase.path !== 'readbackDigest') fixture.readbackDigest = digestWithout(fixture, 'readbackDigest');
  if (testCase.fixture === 'observation' && testCase.path !== 'observationDigest') fixture.observationDigest = digestWithout(fixture, 'observationDigest');
  if (testCase.fixture === 'processingFailure' && testCase.path !== 'failureDigest') fixture.failureDigest = digestWithout(fixture, 'failureDigest');
  const validator = {
    observation: (value) => validateObservation(value, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest),
    processingFailure: (value) => validateProcessingFailure(value, observation),
    record: (value) => validateRecord(value, dispositionSet, authorityRegistry, authorityRoot, runtimeTrustedAuthorityRootDigest, identityOverride, crmProjection),
    delivery: validateDelivery,
    coverage: (value) => validateGovernedCoverage(value),
    crmProjection: validateCrmProjection,
    intentRequest: validateIntentRequest,
    intent: (value) => validateIntent(value, intentRequest, record, baseCrmProjection, crmProjection),
    identityOverride: (value) => validateIdentityOverride(value, authorityRoot),
    authorityRegistry: validateAuthorityRegistry,
    authorityRoot: (value) => validateAuthorityRoot(value, runtimeTrustedAuthorityRootDigest),
    dispositionSet: (value) => validateDispositionJoin(record, value, authorityRegistry, authorityRoot, runtimeTrustedAuthorityRootDigest),
    replicationAck: (value) => validateReplicationAckBinding(value, delivery, briefsReadback),
    briefsReadback: (value) => validateBriefsReadback(value, record, delivery),
  }[testCase.fixture];
  const errors = validator(fixture);
  return { id: testCase.id, pass: errors.includes(testCase.expectError), expected: testCase.expectError, errors };
});
const adversarialResults = [];
const recordAttack = (id, expected, pass, errors = []) => adversarialResults.push({ id, pass, expected, errors });
const g3PositiveResults = [];
const recordG3Positive = (id, expected, errors = []) => {
  const uniqueErrors = [...new Set(errors)];
  g3PositiveResults.push({ id, pass: uniqueErrors.length === 0, expected, errors: uniqueErrors });
  positiveErrors.push(...uniqueErrors.map((error) => `${id}: ${error}`));
};
const g4PositiveResults = [];
const recordG4Positive = (id, expected, errors = []) => {
  const uniqueErrors = [...new Set(errors)];
  g4PositiveResults.push({ id, pass: uniqueErrors.length === 0, expected, errors: uniqueErrors });
  positiveErrors.push(...uniqueErrors.map((error) => `${id}: ${error}`));
};
const g5PositiveResults = [];
const recordG5Positive = (id, expected, errors = []) => {
  const uniqueErrors = [...new Set(errors)];
  g5PositiveResults.push({ id, pass: uniqueErrors.length === 0, expected, errors: uniqueErrors });
  positiveErrors.push(...uniqueErrors.map((error) => `${id}: ${error}`));
};

const wrongOrgDelivery = clone(delivery);
wrongOrgDelivery.orgId = 'attacker-org';
wrongOrgDelivery.manifestDigest = deliveryManifestDigest(wrongOrgDelivery);
const wrongOrgState = deriveSystemState({ record, delivery: wrongOrgDelivery, crmProjection, baseCrmProjection, crmIntentRequests: [intentRequest], crmIntents: [intent], replicationAck, briefsReadback, dispositionSet, authorityRegistry, authorityRoot, trustedAuthorityRootDigest: runtimeTrustedAuthorityRootDigest, identityOverride });
recordAttack('A-001', 'cross-org mixture cannot become ready', !wrongOrgState.recordReady && !wrongOrgState.crmReady && !wrongOrgState.normalNotificationEligible && wrongOrgState.joinErrors.includes('cross-artifact org mismatch'), wrongOrgState.joinErrors);

const missingInteractionProjection = clone(crmProjection);
missingInteractionProjection.interactions = [];
missingInteractionProjection.sourceDigest = sha256(jcs({ accounts: missingInteractionProjection.accounts, contacts: missingInteractionProjection.contacts, engagements: missingInteractionProjection.engagements, opportunities: missingInteractionProjection.opportunities, interactions: missingInteractionProjection.interactions, lifecycleItems: missingInteractionProjection.lifecycleItems }));
missingInteractionProjection.projectionDigest = crmProjectionDigest(missingInteractionProjection);
const missingInteractionDelivery = clone(delivery);
Object.assign(missingInteractionDelivery.crm, { sourceDigest: missingInteractionProjection.sourceDigest, projectionDigest: missingInteractionProjection.projectionDigest });
missingInteractionDelivery.manifestDigest = deliveryManifestDigest(missingInteractionDelivery);
const missingInteractionErrors = validateSystemJoin({ record, delivery: missingInteractionDelivery, crmProjection: missingInteractionProjection, baseCrmProjection, crmIntentRequests: [intentRequest], crmIntents: [intent], replicationAck, briefsReadback, dispositionSet, authorityRegistry, authorityRoot, trustedAuthorityRootDigest: runtimeTrustedAuthorityRootDigest, identityOverride });
recordAttack('A-002', 'CRM interaction required for readiness', missingInteractionErrors.includes('CRM interaction join missing'), missingInteractionErrors);

const arbitraryReadbackIntent = clone(intent);
arbitraryReadbackIntent.authoritativeReadbackDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
arbitraryReadbackIntent.intentDigest = crmIntentDigest(arbitraryReadbackIntent);
const arbitraryReadbackErrors = validateIntent(arbitraryReadbackIntent, intentRequest, record, baseCrmProjection, crmProjection);
recordAttack('A-003', 'arbitrary CRM readback rejected', arbitraryReadbackErrors.includes('applied intent readback binding mismatch'), arbitraryReadbackErrors);

const wrongAppliedContentIntent = clone(intent);
wrongAppliedContentIntent.proposedValue.title = 'Attacker-substituted title';
wrongAppliedContentIntent.proposedValueDigest = sha256(jcs(wrongAppliedContentIntent.proposedValue));
wrongAppliedContentIntent.intentDigest = crmIntentDigest(wrongAppliedContentIntent);
const wrongAppliedContentErrors = validateIntent(wrongAppliedContentIntent, null, record, baseCrmProjection, crmProjection);
recordAttack('A-004', 'exact-write readback content must match request', wrongAppliedContentErrors.includes('applied intent readback content mismatch'), wrongAppliedContentErrors);

const illegalIntentTransition = clone(intent);
illegalIntentTransition.stateVersion = 3;
illegalIntentTransition.previousIntentDigest = pendingIntent.intentDigest;
illegalIntentTransition.intentDigest = crmIntentDigest(illegalIntentTransition);
const illegalIntentTransitionErrors = validateIntentTransition(pendingIntent, illegalIntentTransition);
recordAttack('A-005', 'intent versions form a strict chain', illegalIntentTransitionErrors.includes('intent transition lineage mismatch'), illegalIntentTransitionErrors);

const terminalDelivery = clone(delivery);
const failedReceipt = terminalDelivery.upstreamReceipts.find((item) => item.sink === 'crm_interaction');
Object.assign(failedReceipt, { state: 'TERMINAL_FAILED', previousState: 'RETRYABLE', providerId: null, readbackVersion: null, readbackObjectDigest: null, readbackDigest: null, errorCode: 'CRM_WRITE_FAILED', attempt: 5 });
terminalDelivery.paDeliveryReceipt = {
  sink: 'pa_telegram', notificationKind: 'terminal_exception', sourceKey: 'meeting:demo:v1:exception:crm_interaction', outboundDigest: '8080808080808080808080808080808080808080808080808080808080808080', consequentialDeltaDigest: null, providerMessageId: '1902', correctsProviderMessageId: null, policyVersion: 'pa-notification-v1', linkKind: 'processing_status', durablePath: '/business/crm/meetings/meeting_demo_2026_08_24_01/processing', failedSink: 'crm_interaction', idempotencyKey: 'meeting:demo:v1:pa:exception:crm_interaction', state: 'SUCCEEDED', attempt: 1, leaseVersion: 1, previousState: 'LEASED', firstAttemptAt: '2026-08-24T04:01:45Z', deadlineAt: '2026-08-24T04:16:45Z', nextAttemptAt: null, unknownProbeCount: 0, lastProbeAt: null, leaseOwner: 'meeting-engine:demo', leaseExpiresAt: '2026-08-24T04:03:00Z', readbackVersion: 'telegram:1902', readbackObjectDigest: '8282828282828282828282828282828282828282828282828282828282828282', recordDigest: record.recordDigest, readbackDigest: null, updatedAt: '2026-08-24T04:02:00Z', errorCode: null, reconciliationReceipt: null,
};
terminalDelivery.paDeliveryReceipt.readbackDigest = paReadbackDigest(terminalDelivery.paDeliveryReceipt);
terminalDelivery.manifestDigest = deliveryManifestDigest(terminalDelivery);
const terminalState = deriveSystemState({ record, delivery: terminalDelivery, crmProjection, baseCrmProjection, crmIntentRequests: [intentRequest], crmIntents: [intent], replicationAck, briefsReadback, dispositionSet, authorityRegistry, authorityRoot, trustedAuthorityRootDigest: runtimeTrustedAuthorityRootDigest, identityOverride });
recordAttack('A-006', 'terminal exception never satisfies normal completion', terminalState.exceptionNotified && !terminalState.notificationComplete && !terminalState.overallComplete, terminalState.joinErrors);

const nextRecord = clone(record);
nextRecord.recordVersion = record.recordVersion + 1;
nextRecord.previousRecordDigest = record.recordDigest;
nextRecord.recordDigest = recordDigest(nextRecord);
positiveErrors.push(...validateRecordTransition(record, nextRecord, identityOverride, identityOverride));
const mutatedClaimVersion = clone(nextRecord);
mutatedClaimVersion.claims[0].statement = 'Mutated without a new claim version';
mutatedClaimVersion.claims[0].candidateContentDigest = candidateContentDigest(mutatedClaimVersion.claims[0]);
mutatedClaimVersion.recordDigest = recordDigest(mutatedClaimVersion);
const mutatedClaimTransitionErrors = validateRecordTransition(record, mutatedClaimVersion, identityOverride, identityOverride);
recordAttack('A-007', 'claim content changes require versioned supersession', mutatedClaimTransitionErrors.includes('record transition mutated immutable claim version'), mutatedClaimTransitionErrors);

const priorDelivery = clone(delivery);
priorDelivery.manifestRevision = delivery.manifestRevision - 1;
priorDelivery.manifestDigest = delivery.previousManifestDigest;
priorDelivery.upstreamReceipts.forEach((receipt) => Object.assign(receipt, { state: 'LEASED', previousState: 'PENDING', providerId: null, readbackVersion: null, readbackObjectDigest: null, readbackDigest: null }));
positiveErrors.push(...validateDeliveryTransition(priorDelivery, delivery));
const staleLeaseDelivery = clone(delivery);
staleLeaseDelivery.upstreamReceipts[0].attempt += 1;
const staleLeaseErrors = validateDeliveryTransition(priorDelivery, staleLeaseDelivery);
recordAttack('A-008', 'attempt cannot change outside a consumed retry outcome', staleLeaseErrors.includes('delivery attempt changed outside retry outcome'), staleLeaseErrors);

const reopenedDelivery = clone(delivery);
reopenedDelivery.manifestRevision += 1;
reopenedDelivery.previousManifestDigest = delivery.manifestDigest;
reopenedDelivery.upstreamReceipts[0].state = 'RETRYABLE';
reopenedDelivery.upstreamReceipts[0].previousState = 'SUCCEEDED';
const reopenedErrors = validateDeliveryTransition(delivery, reopenedDelivery);
recordAttack('A-009', 'terminal sink receipts cannot reopen', reopenedErrors.includes('terminal receipt reopened'), reopenedErrors);

const joinedInput = { record, delivery, crmProjection, baseCrmProjection, crmWriteSet, crmIntentRequests: crmWriteSetArtifacts.requests, crmIntents: crmWriteSetArtifacts.intents, replicationAck, briefsReadback, dispositionSet, authorityRegistry, authorityRoot, trustedAuthorityRootDigest: runtimeTrustedAuthorityRootDigest, identityOverride };
const missingDurableIntentState = deriveSystemState({ ...joinedInput, crmIntents: [] });
recordAttack('A-011', 'delivery cannot become ready without CRM-owned durable intent artifact', !missingDurableIntentState.crmReady && missingDurableIntentState.joinErrors.includes('CRM durable intent join missing'), missingDurableIntentState.joinErrors);
positiveErrors.push(...validateCrmProjectionTransition(crmProjection, clone(crmProjection)));
const changedLifecycleIdentityProjection = clone(crmProjection);
changedLifecycleIdentityProjection.lifecycleItems[0].lifecycleId = 'attacker:duplicate-lifecycle-id';
const changedLifecycleIdentityErrors = validateCrmProjectionTransition(crmProjection, changedLifecycleIdentityProjection);
recordAttack('A-012', 'lifecycle identity cannot include mutable state or change across projections', changedLifecycleIdentityErrors.includes('CRM lifecycle stable identity changed'), changedLifecycleIdentityErrors);
const retryWithoutSchedule = clone(delivery);
Object.assign(retryWithoutSchedule.upstreamReceipts[0], { state: 'RETRYABLE', previousState: 'LEASED', providerId: null, readbackVersion: null, readbackObjectDigest: null, readbackDigest: null, errorCode: 'TRANSIENT_FAILURE', nextAttemptAt: null });
retryWithoutSchedule.manifestDigest = deliveryManifestDigest(retryWithoutSchedule);
const retryWithoutScheduleErrors = validateDelivery(retryWithoutSchedule);
recordAttack('A-013', 'retryable receipts require a bounded scheduled retry', retryWithoutScheduleErrors.includes('retryable receipt lacks bounded next attempt'), retryWithoutScheduleErrors);

// G1 terminal-gate reproduction: transplant the enclosing record and
// disposition set to another meeting, rehash only their outer digests, and
// preserve all nine authority decisions plus the opaque identity-basis values.
// Every preserved decision must now fail its meeting/version binding, and every
// preserved identity basis must fail deterministic recomputation.
const transplantedRecord = clone(record);
const transplantedDispositionSet = clone(dispositionSet);
transplantedRecord.canonicalMeetingId = 'meeting_attacker_replay_02';
transplantedDispositionSet.canonicalMeetingId = 'meeting_attacker_replay_02';
transplantedDispositionSet.dispositionSetDigest = dispositionSetDigest(transplantedDispositionSet);
transplantedRecord.claimDispositionSetDigest = transplantedDispositionSet.dispositionSetDigest;
transplantedRecord.recordDigest = recordDigest(transplantedRecord);
const transplantErrors = validateRecord(transplantedRecord, transplantedDispositionSet, authorityRegistry, authorityRoot, runtimeTrustedAuthorityRootDigest, identityOverride, crmProjection);
recordAttack(
  'A-014',
  'claim authority and identity basis cannot be transplanted across meetings',
  transplantErrors.includes('decisionDigest mismatch') && transplantErrors.includes('identityBasisDigest mismatch') && transplantErrors.includes('claim disposition content mismatch'),
  transplantErrors,
);

// Evidence lineage is part of both the recomputed identity basis and each
// authorized decision. Rewriting a source lineage while preserving those
// digests must fail even when the enclosing record hash is refreshed.
const lineageRewriteRecord = clone(record);
lineageRewriteRecord.sourceObservations[0].lineageDigest = 'abababababababababababababababababababababababababababababababab';
for (const artifact of lineageRewriteRecord.artifacts.filter((item) => item.sourceId === lineageRewriteRecord.sourceObservations[0].sourceId)) artifact.sourceLineageDigest = lineageRewriteRecord.sourceObservations[0].lineageDigest;
lineageRewriteRecord.recordDigest = recordDigest(lineageRewriteRecord);
const lineageRewriteErrors = validateRecord(lineageRewriteRecord, dispositionSet, authorityRegistry, authorityRoot, runtimeTrustedAuthorityRootDigest, identityOverride, crmProjection);
recordAttack(
  'A-015',
  'claim authority and identity basis bind recomputed evidence lineage',
  lineageRewriteErrors.includes('identityBasisDigest mismatch') && lineageRewriteErrors.includes('claim disposition content mismatch'),
  lineageRewriteErrors,
);

// G3: lifecycle identity is immutable in both directions. A stable lifecycle
// row ID may not be rebound to another canonical claim.
recordG3Positive('G3-P-001', 'unchanged lifecycle identities remain valid bidirectionally', validateCrmProjectionTransition(crmProjection, clone(crmProjection)));
const reverseLifecycleSubstitution = clone(crmProjection);
reverseLifecycleSubstitution.lifecycleItems[0].canonicalClaimId = 'canonical:attacker-substitution';
const reverseLifecycleErrors = validateCrmProjectionTransition(crmProjection, reverseLifecycleSubstitution);
recordAttack('A-036', 'lifecycleId cannot be rebound to another canonicalClaimId', reverseLifecycleErrors.includes('CRM lifecycle reverse stable identity changed'), reverseLifecycleErrors);

// Every acquisition receives a fresh fence even when the logical attempt is
// unchanged. This reproduces the RETRYABLE -> LEASED same-attempt attack.
const retryableBeforeLease = clone(delivery);
Object.assign(retryableBeforeLease.upstreamReceipts[0], { state: 'RETRYABLE', previousState: 'LEASED', providerId: null, readbackVersion: null, readbackObjectDigest: null, readbackDigest: null, errorCode: 'TRANSIENT_FAILURE', attempt: 1, leaseVersion: 1, updatedAt: '2026-08-24T04:01:00Z', nextAttemptAt: '2026-08-24T04:01:30Z', unknownProbeCount: 0, lastProbeAt: null });
retryableBeforeLease.manifestDigest = deliveryManifestDigest(retryableBeforeLease);
const staleFenceLease = clone(retryableBeforeLease);
staleFenceLease.manifestRevision += 1;
staleFenceLease.previousManifestDigest = retryableBeforeLease.manifestDigest;
Object.assign(staleFenceLease.upstreamReceipts[0], { state: 'LEASED', previousState: 'RETRYABLE', errorCode: null, updatedAt: '2026-08-24T04:01:30Z', nextAttemptAt: null });
staleFenceLease.manifestDigest = deliveryManifestDigest(staleFenceLease);
const staleFenceErrors = [...validateDelivery(staleFenceLease), ...validateDeliveryTransition(retryableBeforeLease, staleFenceLease)];
recordAttack('A-037', 'every lease acquisition advances the fence', staleFenceErrors.includes('delivery lease acquisition lineage invalid'), staleFenceErrors);
const fencedLease = clone(staleFenceLease);
fencedLease.upstreamReceipts[0].leaseVersion = 2;
fencedLease.manifestDigest = deliveryManifestDigest(fencedLease);
recordG3Positive('G3-P-002', 'same-attempt reacquisition with an advanced fence is valid', [...validateDelivery(fencedLease), ...validateDeliveryTransition(retryableBeforeLease, fencedLease)]);

const leasedWithProbeState = clone(delivery);
Object.assign(leasedWithProbeState.upstreamReceipts[0], { state: 'LEASED', previousState: 'PENDING', providerId: null, readbackVersion: null, readbackObjectDigest: null, readbackDigest: null, unknownProbeCount: 1, lastProbeAt: '2026-08-24T04:01:00Z', updatedAt: '2026-08-24T04:01:00Z' });
leasedWithProbeState.manifestDigest = deliveryManifestDigest(leasedWithProbeState);
const leasedProbeErrors = validateDelivery(leasedWithProbeState);
recordAttack('A-038', 'probe fields are legal only on UNKNOWN_COMMIT', leasedProbeErrors.includes('non-unknown receipt carries probe state'), leasedProbeErrors);

// CRM UNKNOWN_COMMIT exits are allowed only with a CRM-owned readback receipt
// bound to the original request, unknown intent version, target, value, and
// terminal outcome.
const unknownIntent = clone(pendingIntent);
Object.assign(unknownIntent, { state: 'unknown_commit', stateVersion: 2, previousIntentDigest: pendingIntent.intentDigest, authoritativeReadbackVersion: null, authoritativeReadbackDigest: null, reconciliationReceipt: null, rejectionCode: null, updatedAt: '2026-08-24T04:01:00Z' });
unknownIntent.intentDigest = crmIntentDigest(unknownIntent);
recordG3Positive('G3-P-003', 'accepted intent may enter UNKNOWN_COMMIT without terminal state', [...validateIntent(unknownIntent, intentRequest, record, baseCrmProjection, crmProjection), ...validateIntentTransition(pendingIntent, unknownIntent)]);
const buildReconciledExit = (state) => {
  const reconciled = clone(intent);
  Object.assign(reconciled, { state, stateVersion: 3, previousIntentDigest: unknownIntent.intentDigest, authoritativeReadbackVersion: crmProjection.sourceVersion, authoritativeReadbackDigest: crmProjection.sourceDigest, rejectionCode: state === 'applied' ? null : state === 'rejected' ? 'AUTHORITATIVE_NOT_APPLIED' : 'RECONCILIATION_TERMINAL', updatedAt: '2026-08-24T04:02:00Z' });
  reconciled.reconciliationReceipt = {
    schemaVersion: '1.0',
    orgId: reconciled.orgId,
    intentId: reconciled.intentId,
    requestDigest: reconciled.requestDigest,
    unknownIntentDigest: unknownIntent.intentDigest,
    operation: reconciled.operation,
    target: clone(reconciled.target),
    proposedValueDigest: reconciled.proposedValueDigest,
    outcome: state,
    authoritativeReadbackVersion: reconciled.authoritativeReadbackVersion,
    authoritativeReadbackDigest: reconciled.authoritativeReadbackDigest,
    authority: { owner: 'crm-agent', policyVersion: 'crm-unknown-reconciliation-v1' },
    reconciledAt: '2026-08-24T04:01:59Z',
    receiptDigest: null,
  };
  reconciled.reconciliationReceipt.receiptDigest = reconciliationReceiptDigest(reconciled.reconciliationReceipt);
  reconciled.intentDigest = crmIntentDigest(reconciled);
  return reconciled;
};
const reconciledExits = ['applied', 'rejected', 'terminal_failed'].map(buildReconciledExit);
for (const [index, reconciled] of reconciledExits.entries()) recordG3Positive(`G3-P-00${4 + index}`, `UNKNOWN_COMMIT may resolve to ${reconciled.state} with authoritative reconciliation`, [...validateIntent(reconciled, intentRequest, record, baseCrmProjection, crmProjection), ...validateIntentTransition(unknownIntent, reconciled)]);
const unreconciledRejected = clone(reconciledExits[1]);
Object.assign(unreconciledRejected, { authoritativeReadbackVersion: null, authoritativeReadbackDigest: null, reconciliationReceipt: null });
unreconciledRejected.intentDigest = crmIntentDigest(unreconciledRejected);
const unreconciledErrors = [...validateIntent(unreconciledRejected, intentRequest, record, baseCrmProjection, crmProjection), ...validateIntentTransition(unknownIntent, unreconciledRejected)];
recordAttack('A-039', 'UNKNOWN_COMMIT exit requires authoritative reconciliation', unreconciledErrors.includes('UNKNOWN_COMMIT exit lacks authoritative reconciliation'), unreconciledErrors);
const wrongReconciliationRequest = clone(reconciledExits[0]);
wrongReconciliationRequest.reconciliationReceipt.requestDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
wrongReconciliationRequest.reconciliationReceipt.receiptDigest = reconciliationReceiptDigest(wrongReconciliationRequest.reconciliationReceipt);
wrongReconciliationRequest.intentDigest = crmIntentDigest(wrongReconciliationRequest);
const wrongReconciliationRequestErrors = [...validateIntent(wrongReconciliationRequest, intentRequest, record, baseCrmProjection, crmProjection), ...validateIntentTransition(unknownIntent, wrongReconciliationRequest)];
recordAttack('A-040', 'reconciliation receipt binds the originating request', wrongReconciliationRequestErrors.includes('reconciliation receipt binding mismatch'), wrongReconciliationRequestErrors);
const wrongReconciliationOutcome = clone(reconciledExits[0]);
wrongReconciliationOutcome.reconciliationReceipt.outcome = 'rejected';
wrongReconciliationOutcome.reconciliationReceipt.receiptDigest = reconciliationReceiptDigest(wrongReconciliationOutcome.reconciliationReceipt);
wrongReconciliationOutcome.intentDigest = crmIntentDigest(wrongReconciliationOutcome);
const wrongReconciliationOutcomeErrors = validateIntent(wrongReconciliationOutcome, intentRequest, record, baseCrmProjection, crmProjection);
recordAttack('A-041', 'reconciliation receipt binds the resolved outcome', wrongReconciliationOutcomeErrors.includes('reconciliation receipt binding mismatch'), wrongReconciliationOutcomeErrors);
const wrongReconciliationReadback = clone(reconciledExits[0]);
wrongReconciliationReadback.reconciliationReceipt.authoritativeReadbackDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
wrongReconciliationReadback.reconciliationReceipt.receiptDigest = reconciliationReceiptDigest(wrongReconciliationReadback.reconciliationReceipt);
wrongReconciliationReadback.intentDigest = crmIntentDigest(wrongReconciliationReadback);
const wrongReconciliationReadbackErrors = validateIntent(wrongReconciliationReadback, intentRequest, record, baseCrmProjection, crmProjection);
recordAttack('A-042', 'reconciliation receipt binds authoritative readback', wrongReconciliationReadbackErrors.includes('reconciliation authoritative readback mismatch'), wrongReconciliationReadbackErrors);

// Terminal receipt history is carried byte-for-byte; previousState describes
// the transition that created the terminal receipt and is never rewritten.
const terminalCarryForward = clone(delivery);
terminalCarryForward.manifestRevision += 1;
terminalCarryForward.previousManifestDigest = delivery.manifestDigest;
terminalCarryForward.manifestDigest = deliveryManifestDigest(terminalCarryForward);
recordG3Positive('G3-P-007', 'byte-identical terminal receipts carry forward across manifest revisions', [...validateDelivery(terminalCarryForward), ...validateDeliveryTransition(delivery, terminalCarryForward)]);
const mutatedTerminalCarryForward = clone(terminalCarryForward);
mutatedTerminalCarryForward.upstreamReceipts[0].updatedAt = '2026-08-24T04:01:01Z';
mutatedTerminalCarryForward.manifestDigest = deliveryManifestDigest(mutatedTerminalCarryForward);
const mutatedTerminalErrors = validateDeliveryTransition(delivery, mutatedTerminalCarryForward);
recordAttack('A-043', 'terminal receipt carry-forward is byte-identical', mutatedTerminalErrors.includes('terminal receipt carry-forward mutated'), mutatedTerminalErrors);

for (const [index, field] of ['transcriptDigest', 'evidenceDigest', 'lineageDigest'].entries()) {
  const rewrittenSourceRecord = clone(nextRecord);
  rewrittenSourceRecord.sourceObservations[0][field] = `${String(index + 6).repeat(64)}`.slice(0, 64);
  rewrittenSourceRecord.recordDigest = recordDigest(rewrittenSourceRecord);
  const sourceRewriteErrors = validateRecordTransition(record, rewrittenSourceRecord, identityOverride, identityOverride);
  recordAttack(`A-${String(44 + index).padStart(3, '0')}`, `source ${field} cannot rewrite under the same identity`, sourceRewriteErrors.includes('record transition rewrote immutable source evidence'), sourceRewriteErrors);
}
const explicitSourceSupersession = clone(nextRecord);
const formerActive = explicitSourceSupersession.sourceObservations.find((source) => source.state === 'active');
const replacementSource = clone(formerActive);
replacementSource.sourceId = '01DEMONEWIDENTITY00000000000';
replacementSource.capturedAt = '2026-08-24T04:10:00Z';
Object.assign(formerActive, { state: 'superseded', supersededBy: replacementSource.sourceId, dispositionReason: 'new immutable source identity supersedes prior bytes', tombstoneId: 'tombstone:demo:v2', reingestAllowed: false, retiredIdentity: true });
explicitSourceSupersession.sourceObservations.push(replacementSource);
const nextOverride = clone(identityOverride);
nextOverride.overrideVersion += 1;
nextOverride.supersedesOverrideDigest = identityOverride.overrideDigest;
nextOverride.sourceIds.push(replacementSource.sourceId);
nextOverride.canonicalSourceId = replacementSource.sourceId;
nextOverride.authority.decidedAt = '2026-08-24T04:10:01Z';
nextOverride.authority.decisionDigest = identityDecisionDigest(nextOverride);
nextOverride.overrideDigest = identityOverrideDigest(nextOverride);
Object.assign(explicitSourceSupersession.identityPolicy, { overrideId: nextOverride.overrideId, overrideVersion: nextOverride.overrideVersion, overrideDigest: nextOverride.overrideDigest });
explicitSourceSupersession.recordDigest = recordDigest(explicitSourceSupersession);
recordG3Positive('G3-P-008', 'new source identity with explicit tombstone and supersession is valid', validateRecordTransition(record, explicitSourceSupersession, identityOverride, nextOverride));

const unknownProbeDelivery = clone(delivery);
Object.assign(unknownProbeDelivery.upstreamReceipts[0], { state: 'UNKNOWN_COMMIT', previousState: 'LEASED', providerId: null, readbackVersion: null, readbackObjectDigest: null, readbackDigest: null, errorCode: null, unknownProbeCount: 1, lastProbeAt: '2026-08-24T04:01:00Z', updatedAt: '2026-08-24T04:01:00Z', nextAttemptAt: null });
unknownProbeDelivery.manifestDigest = deliveryManifestDigest(unknownProbeDelivery);
recordG3Positive('G3-P-009', 'UNKNOWN probe state inside the bounded window is valid', validateDelivery(unknownProbeDelivery));
const earlyProbeDelivery = clone(unknownProbeDelivery);
earlyProbeDelivery.upstreamReceipts[0].lastProbeAt = '2026-08-24T04:00:00Z';
earlyProbeDelivery.manifestDigest = deliveryManifestDigest(earlyProbeDelivery);
const earlyProbeErrors = validateDelivery(earlyProbeDelivery);
recordAttack('A-047', 'UNKNOWN probe cannot precede first attempt', earlyProbeErrors.includes('unknown commit probe timing invalid'), earlyProbeErrors);
const lateProbeDelivery = clone(unknownProbeDelivery);
lateProbeDelivery.upstreamReceipts[0].lastProbeAt = '2026-08-24T04:16:00Z';
lateProbeDelivery.upstreamReceipts[0].updatedAt = '2026-08-24T04:16:00Z';
lateProbeDelivery.manifestDigest = deliveryManifestDigest(lateProbeDelivery);
const lateProbeErrors = validateDelivery(lateProbeDelivery);
recordAttack('A-048', 'UNKNOWN probe is bounded to fifteen minutes', lateProbeErrors.includes('unknown commit probe timing invalid'), lateProbeErrors);
const monotonicProbeDelivery = clone(unknownProbeDelivery);
monotonicProbeDelivery.manifestRevision += 1;
monotonicProbeDelivery.previousManifestDigest = unknownProbeDelivery.manifestDigest;
Object.assign(monotonicProbeDelivery.upstreamReceipts[0], { previousState: 'UNKNOWN_COMMIT', unknownProbeCount: 2, lastProbeAt: '2026-08-24T04:02:00Z', updatedAt: '2026-08-24T04:02:00Z' });
monotonicProbeDelivery.manifestDigest = deliveryManifestDigest(monotonicProbeDelivery);
recordG3Positive('G3-P-010', 'UNKNOWN probes advance count and timestamp monotonically', [...validateDelivery(monotonicProbeDelivery), ...validateDeliveryTransition(unknownProbeDelivery, monotonicProbeDelivery)]);
const nonMonotonicProbeDelivery = clone(monotonicProbeDelivery);
nonMonotonicProbeDelivery.upstreamReceipts[0].lastProbeAt = unknownProbeDelivery.upstreamReceipts[0].lastProbeAt;
nonMonotonicProbeDelivery.manifestDigest = deliveryManifestDigest(nonMonotonicProbeDelivery);
const nonMonotonicProbeErrors = validateDeliveryTransition(unknownProbeDelivery, nonMonotonicProbeDelivery);
recordAttack('A-049', 'UNKNOWN probes advance count and time monotonically', nonMonotonicProbeErrors.includes('delivery UNKNOWN_COMMIT probes not monotonic'), nonMonotonicProbeErrors);
const boundedRetryDelivery = clone(delivery);
Object.assign(boundedRetryDelivery.upstreamReceipts[0], { state: 'RETRYABLE', previousState: 'LEASED', providerId: null, readbackVersion: null, readbackObjectDigest: null, readbackDigest: null, errorCode: 'TRANSIENT_FAILURE', attempt: 2, leaseVersion: 2, unknownProbeCount: 0, lastProbeAt: null, updatedAt: '2026-08-24T04:01:00Z', nextAttemptAt: '2026-08-24T04:02:00Z' });
boundedRetryDelivery.manifestDigest = deliveryManifestDigest(boundedRetryDelivery);
recordG3Positive('G3-P-011', 'retry backoff at the monotonic floor is valid', validateDelivery(boundedRetryDelivery));
const shortBackoffDelivery = clone(boundedRetryDelivery);
shortBackoffDelivery.upstreamReceipts[0].nextAttemptAt = '2026-08-24T04:01:30Z';
shortBackoffDelivery.manifestDigest = deliveryManifestDigest(shortBackoffDelivery);
const shortBackoffErrors = validateDelivery(shortBackoffDelivery);
recordAttack('A-050', 'retry backoff cannot shrink below the monotonic floor', shortBackoffErrors.includes('retry backoff not bounded monotonic'), shortBackoffErrors);
const longBackoffDelivery = clone(boundedRetryDelivery);
longBackoffDelivery.upstreamReceipts[0].nextAttemptAt = '2026-08-24T04:03:01Z';
longBackoffDelivery.manifestDigest = deliveryManifestDigest(longBackoffDelivery);
const longBackoffErrors = validateDelivery(longBackoffDelivery);
recordAttack('A-051', 'retry backoff cannot exceed the bounded ceiling', longBackoffErrors.includes('retry backoff not bounded monotonic'), longBackoffErrors);

// Second-review G3 closure: retry attempts are consumed by RETRYABLE outcomes,
// leases advance only on subsequent acquisition, and the original attempt
// window is immutable across every manifest revision.
const initialPendingDelivery = clone(delivery);
Object.assign(initialPendingDelivery.upstreamReceipts[0], {
  state: 'PENDING', previousState: null, attempt: 0, leaseVersion: 0,
  providerId: null, readbackVersion: null, readbackObjectDigest: null, readbackDigest: null,
  errorCode: null, updatedAt: '2026-08-24T04:00:30Z', nextAttemptAt: null,
  unknownProbeCount: 0, lastProbeAt: null, leaseOwner: null, leaseExpiresAt: null,
  reconciliationReceipt: null,
});
initialPendingDelivery.manifestDigest = deliveryManifestDigest(initialPendingDelivery);
const initialLeasedDelivery = clone(initialPendingDelivery);
initialLeasedDelivery.manifestRevision += 1;
initialLeasedDelivery.previousManifestDigest = initialPendingDelivery.manifestDigest;
Object.assign(initialLeasedDelivery.upstreamReceipts[0], {
  state: 'LEASED', previousState: 'PENDING', leaseVersion: 1,
  updatedAt: '2026-08-24T04:00:31Z', leaseOwner: 'meeting-engine:initial',
  leaseExpiresAt: '2026-08-24T04:01:31Z',
});
initialLeasedDelivery.manifestDigest = deliveryManifestDigest(initialLeasedDelivery);
recordG3Positive('G3-P-017', 'initial PENDING to LEASED acquisition advances a live fence without consuming an attempt', [
  ...validateDelivery(initialPendingDelivery),
  ...validateDelivery(initialLeasedDelivery),
  ...validateDeliveryTransition(initialPendingDelivery, initialLeasedDelivery),
]);
const lineageLeased = clone(delivery);
Object.assign(lineageLeased.upstreamReceipts[0], {
  state: 'LEASED', previousState: 'PENDING', attempt: 1, leaseVersion: 1,
  providerId: null, readbackVersion: null, readbackObjectDigest: null, readbackDigest: null,
  errorCode: null, updatedAt: '2026-08-24T04:00:40Z', nextAttemptAt: null,
  unknownProbeCount: 0, lastProbeAt: null, leaseOwner: 'meeting-engine:lineage',
  leaseExpiresAt: '2026-08-24T04:01:40Z', reconciliationReceipt: null,
});
lineageLeased.manifestDigest = deliveryManifestDigest(lineageLeased);
const lineageRetryable = clone(lineageLeased);
lineageRetryable.manifestRevision += 1;
lineageRetryable.previousManifestDigest = lineageLeased.manifestDigest;
Object.assign(lineageRetryable.upstreamReceipts[0], {
  state: 'RETRYABLE', previousState: 'LEASED', attempt: 2, leaseVersion: 1,
  errorCode: 'TRANSIENT_FAILURE', updatedAt: '2026-08-24T04:01:00Z', nextAttemptAt: '2026-08-24T04:02:00Z',
});
lineageRetryable.manifestDigest = deliveryManifestDigest(lineageRetryable);
const lineageReLeased = clone(lineageRetryable);
lineageReLeased.manifestRevision += 1;
lineageReLeased.previousManifestDigest = lineageRetryable.manifestDigest;
Object.assign(lineageReLeased.upstreamReceipts[0], {
  state: 'LEASED', previousState: 'RETRYABLE', attempt: 2, leaseVersion: 2,
  errorCode: null, updatedAt: '2026-08-24T04:02:00Z', nextAttemptAt: null,
  leaseOwner: 'meeting-engine:lineage', leaseExpiresAt: '2026-08-24T04:03:00Z',
});
lineageReLeased.manifestDigest = deliveryManifestDigest(lineageReLeased);
recordG3Positive('G3-P-012', 'retry outcome consumes one attempt and the following live lease advances only the fence', [
  ...validateDelivery(lineageRetryable),
  ...validateDeliveryTransition(lineageLeased, lineageRetryable),
  ...validateDelivery(lineageReLeased),
  ...validateDeliveryTransition(lineageRetryable, lineageReLeased),
]);

const buildAttemptReconciliation = (priorReceipt, currentReceipt, outcomeVersion) => {
  const reconciliation = {
    schemaVersion: '1.0',
    sink: currentReceipt.sink,
    idempotencyKey: currentReceipt.idempotencyKey,
    unknownStateDigest: attemptReceiptDigest(priorReceipt),
    outcome: currentReceipt.state,
    outcomeVersion,
    outcomeDigest: '',
    authority: { owner: 'sink-adapter', policyVersion: 'unknown-commit-reconciliation-v1' },
    reconciledAt: currentReceipt.updatedAt,
    receiptDigest: '',
  };
  reconciliation.outcomeDigest = attemptReconciliationOutcomeDigest(currentReceipt, reconciliation);
  reconciliation.receiptDigest = attemptReconciliationReceiptDigest(reconciliation);
  return reconciliation;
};
const unknownLineage = clone(delivery);
Object.assign(unknownLineage.upstreamReceipts[0], {
  state: 'UNKNOWN_COMMIT', previousState: 'LEASED', providerId: null,
  readbackVersion: null, readbackObjectDigest: null, readbackDigest: null,
  errorCode: null, unknownProbeCount: 1, lastProbeAt: '2026-08-24T04:01:00Z',
  updatedAt: '2026-08-24T04:01:00Z', nextAttemptAt: null, reconciliationReceipt: null,
});
unknownLineage.manifestDigest = deliveryManifestDigest(unknownLineage);
const reconciledSucceededDelivery = clone(unknownLineage);
reconciledSucceededDelivery.manifestRevision += 1;
reconciledSucceededDelivery.previousManifestDigest = unknownLineage.manifestDigest;
Object.assign(reconciledSucceededDelivery.upstreamReceipts[0], clone(delivery.upstreamReceipts[0]), {
  previousState: 'UNKNOWN_COMMIT', updatedAt: '2026-08-24T04:02:00Z', reconciliationReceipt: null,
});
reconciledSucceededDelivery.upstreamReceipts[0].reconciliationReceipt = buildAttemptReconciliation(unknownLineage.upstreamReceipts[0], reconciledSucceededDelivery.upstreamReceipts[0], 'briefs-provider-reconcile-v1');
reconciledSucceededDelivery.manifestDigest = deliveryManifestDigest(reconciledSucceededDelivery);
recordG3Positive('G3-P-013', 'UNKNOWN_COMMIT resolves to SUCCEEDED only with a bound authoritative reconciliation receipt', [
  ...validateDelivery(reconciledSucceededDelivery),
  ...validateDeliveryTransition(unknownLineage, reconciledSucceededDelivery),
]);
const reconciledTerminalDelivery = clone(unknownLineage);
reconciledTerminalDelivery.manifestRevision += 1;
reconciledTerminalDelivery.previousManifestDigest = unknownLineage.manifestDigest;
Object.assign(reconciledTerminalDelivery.upstreamReceipts[0], {
  state: 'TERMINAL_FAILED', previousState: 'UNKNOWN_COMMIT', errorCode: 'AUTHORITATIVE_NOT_COMMITTED',
  unknownProbeCount: 0, lastProbeAt: null, updatedAt: '2026-08-24T04:02:00Z', reconciliationReceipt: null,
});
reconciledTerminalDelivery.upstreamReceipts[0].reconciliationReceipt = buildAttemptReconciliation(unknownLineage.upstreamReceipts[0], reconciledTerminalDelivery.upstreamReceipts[0], 'briefs-provider-reconcile-v1');
reconciledTerminalDelivery.manifestDigest = deliveryManifestDigest(reconciledTerminalDelivery);
recordG3Positive('G3-P-014', 'UNKNOWN_COMMIT resolves to TERMINAL_FAILED only with a bound authoritative reconciliation receipt', [
  ...validateDelivery(reconciledTerminalDelivery),
  ...validateDeliveryTransition(unknownLineage, reconciledTerminalDelivery),
]);

const unknownToLease = clone(unknownLineage);
unknownToLease.manifestRevision += 1;
unknownToLease.previousManifestDigest = unknownLineage.manifestDigest;
Object.assign(unknownToLease.upstreamReceipts[0], {
  state: 'LEASED', previousState: 'UNKNOWN_COMMIT', leaseVersion: 2,
  unknownProbeCount: 0, lastProbeAt: null, updatedAt: '2026-08-24T04:02:00Z',
  leaseExpiresAt: '2026-08-24T04:03:00Z', reconciliationReceipt: null,
});
unknownToLease.manifestDigest = deliveryManifestDigest(unknownToLease);
const unknownToLeaseErrors = [...validateDelivery(unknownToLease), ...validateDeliveryTransition(unknownLineage, unknownToLease)];
recordAttack('A-106', 'UNKNOWN_COMMIT cannot re-enter LEASED as a retry acquisition', unknownToLeaseErrors.includes('delivery UNKNOWN_COMMIT exit state invalid'), unknownToLeaseErrors);
const unreconciledSucceededDelivery = clone(reconciledSucceededDelivery);
unreconciledSucceededDelivery.upstreamReceipts[0].reconciliationReceipt = null;
unreconciledSucceededDelivery.manifestDigest = deliveryManifestDigest(unreconciledSucceededDelivery);
const unreconciledSucceededErrors = validateDeliveryTransition(unknownLineage, unreconciledSucceededDelivery);
recordAttack('A-107', 'UNKNOWN_COMMIT terminal exit requires authoritative reconciliation', unreconciledSucceededErrors.includes('delivery UNKNOWN_COMMIT exit lacks authoritative reconciliation'), unreconciledSucceededErrors);
const wrongUnknownDigestDelivery = clone(reconciledSucceededDelivery);
wrongUnknownDigestDelivery.upstreamReceipts[0].reconciliationReceipt.unknownStateDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
wrongUnknownDigestDelivery.upstreamReceipts[0].reconciliationReceipt.outcomeDigest = attemptReconciliationOutcomeDigest(wrongUnknownDigestDelivery.upstreamReceipts[0], wrongUnknownDigestDelivery.upstreamReceipts[0].reconciliationReceipt);
wrongUnknownDigestDelivery.upstreamReceipts[0].reconciliationReceipt.receiptDigest = attemptReconciliationReceiptDigest(wrongUnknownDigestDelivery.upstreamReceipts[0].reconciliationReceipt);
wrongUnknownDigestDelivery.manifestDigest = deliveryManifestDigest(wrongUnknownDigestDelivery);
const wrongUnknownDigestErrors = validateDeliveryTransition(unknownLineage, wrongUnknownDigestDelivery);
recordAttack('A-108', 'reconciliation binds the exact UNKNOWN_COMMIT predecessor state', wrongUnknownDigestErrors.includes('delivery UNKNOWN_COMMIT reconciliation transition mismatch'), wrongUnknownDigestErrors);
const fixedAttemptRetry = clone(lineageRetryable);
fixedAttemptRetry.upstreamReceipts[0].attempt = lineageLeased.upstreamReceipts[0].attempt;
fixedAttemptRetry.manifestDigest = deliveryManifestDigest(fixedAttemptRetry);
const fixedAttemptRetryErrors = validateDeliveryTransition(lineageLeased, fixedAttemptRetry);
recordAttack('A-109', 'every RETRYABLE outcome consumes exactly one attempt', fixedAttemptRetryErrors.includes('delivery retry outcome did not consume attempt'), fixedAttemptRetryErrors);
const rewrittenFirstAttempt = clone(lineageRetryable);
rewrittenFirstAttempt.upstreamReceipts[0].firstAttemptAt = '2026-08-24T04:00:31Z';
rewrittenFirstAttempt.manifestDigest = deliveryManifestDigest(rewrittenFirstAttempt);
const rewrittenFirstAttemptErrors = validateDeliveryTransition(lineageLeased, rewrittenFirstAttempt);
recordAttack('A-110', 'firstAttemptAt is immutable across the sink/idempotency lineage', rewrittenFirstAttemptErrors.includes('delivery attempt window mutated'), rewrittenFirstAttemptErrors);
const rewrittenDeadline = clone(lineageRetryable);
rewrittenDeadline.upstreamReceipts[0].deadlineAt = '2026-08-24T04:30:29Z';
rewrittenDeadline.manifestDigest = deliveryManifestDigest(rewrittenDeadline);
const rewrittenDeadlineErrors = validateDeliveryTransition(lineageLeased, rewrittenDeadline);
recordAttack('A-111', 'deadlineAt is immutable across the sink/idempotency lineage', rewrittenDeadlineErrors.includes('delivery attempt window mutated'), rewrittenDeadlineErrors);
const exhaustedAttempt = clone(lineageRetryable);
exhaustedAttempt.upstreamReceipts[0].attempt = 6;
exhaustedAttempt.manifestDigest = deliveryManifestDigest(exhaustedAttempt);
const exhaustedAttemptErrors = validateDelivery(exhaustedAttempt);
recordAttack('A-112', 'the whole retry lineage is capped at five attempts', exhaustedAttemptErrors.includes('retry attempt bounds invalid') && exhaustedAttemptErrors.includes('schema validation failed'), exhaustedAttemptErrors);
const expiredLease = clone(lineageReLeased);
expiredLease.upstreamReceipts[0].leaseExpiresAt = expiredLease.upstreamReceipts[0].updatedAt;
expiredLease.manifestDigest = deliveryManifestDigest(expiredLease);
const expiredLeaseErrors = validateDelivery(expiredLease);
recordAttack('A-113', 'LEASED requires leaseExpiresAt strictly after updatedAt', expiredLeaseErrors.includes('leased receipt is not live at update'), expiredLeaseErrors);
const scheduledLease = clone(lineageReLeased);
scheduledLease.upstreamReceipts[0].nextAttemptAt = '2026-08-24T04:02:30Z';
scheduledLease.manifestDigest = deliveryManifestDigest(scheduledLease);
const scheduledLeaseErrors = validateDelivery(scheduledLease);
recordAttack('A-114', 'LEASED cannot retain retry scheduling state', scheduledLeaseErrors.includes('leased receipt carries retry/probe state'), scheduledLeaseErrors);
const ownerlessLease = clone(lineageReLeased);
ownerlessLease.upstreamReceipts[0].leaseOwner = null;
ownerlessLease.manifestDigest = deliveryManifestDigest(ownerlessLease);
const ownerlessLeaseErrors = validateDelivery(ownerlessLease);
recordAttack('A-115', 'LEASED requires a valid owner and positive fence', ownerlessLeaseErrors.includes('leased receipt lacks valid owner/fence'), ownerlessLeaseErrors);

// G4: internal relay authorization is a keyed canonical-request receipt, not a
// collection of attacker-recomputable public digests.
recordG4Positive('G4-P-001', 'org-bound relay HMAC and replay-store receipt validate with the configured test key', validateObservation(observation, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest));
const rehashRelayFixture = (fixture, secret, refreshNonceKey = true) => {
  const payload = relayCanonicalPayload(fixture);
  fixture.relay.internalAuth.canonicalRequestDigest = sha256(payload);
  fixture.relay.internalAuth.macHex = hmacHex(secret, payload);
  fixture.relay.relayReceiptDigest = fixture.relay.internalAuth.macHex;
  if (refreshNonceKey) fixture.relay.replayReceipt.nonceKey = sha256(jcs({ orgId: fixture.orgId, keyId: fixture.relay.internalAuth.keyId, nonce: fixture.relay.internalAuth.nonce }));
  fixture.relay.replayReceipt.receiptMacHex = hmacHex(secret, replayReceiptPayload(fixture));
  fixture.observationDigest = digestWithout(fixture, 'observationDigest');
  return fixture;
};
const rehashObservationVerification = (fixture) => {
  const verification = fixture.signatureVerification;
  verification.verificationReceiptDigest = sha256(jcs({ provider: fixture.provider, providerSourceId: fixture.providerSourceId, rawBodyDigest: fixture.rawBodyDigest, scheme: verification.scheme, headerName: verification.headerName, headerValueDigest: verification.headerValueDigest, keyId: verification.keyId, keyConfigVersion: verification.keyConfigVersion, verificationConfigDigest: verification.verificationConfigDigest, providerDocsSource: verification.providerDocsSource, verifiedAt: verification.verifiedAt, verified: verification.verified }));
  fixture.observationDigest = digestWithout(fixture, 'observationDigest');
  return fixture;
};
const publicDigestRelayForgery = clone(observation);
publicDigestRelayForgery.relay.idempotencyKey = 'attacker-recomputed-public-digests';
const forgedCanonicalPayload = relayCanonicalPayload(publicDigestRelayForgery);
publicDigestRelayForgery.relay.internalAuth.canonicalRequestDigest = sha256(forgedCanonicalPayload);
publicDigestRelayForgery.relay.internalAuth.macHex = sha256(forgedCanonicalPayload);
publicDigestRelayForgery.relay.relayReceiptDigest = publicDigestRelayForgery.relay.internalAuth.macHex;
publicDigestRelayForgery.relay.replayReceipt.receiptMacHex = sha256(replayReceiptPayload(publicDigestRelayForgery));
publicDigestRelayForgery.observationDigest = digestWithout(publicDigestRelayForgery, 'observationDigest');
const publicDigestForgeryErrors = validateObservation(publicDigestRelayForgery, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-052', 'public digest recomputation cannot forge relay authorization', publicDigestForgeryErrors.includes('relay HMAC mismatch'), publicDigestForgeryErrors);
const wrongOrgRelay = clone(observation);
wrongOrgRelay.orgId = 'attacker-org';
wrongOrgRelay.relay.intentDigest = sha256(jcs({ orgId: wrongOrgRelay.orgId, observationId: wrongOrgRelay.observationId, provider: wrongOrgRelay.provider, providerSourceId: wrongOrgRelay.providerSourceId, rawBodyDigest: wrongOrgRelay.rawBodyDigest }));
rehashRelayFixture(wrongOrgRelay, relayTestSecrets.secretsByKeyId['cortext-relay-key-v1']);
const wrongOrgRelayErrors = validateObservation(wrongOrgRelay, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-053', 'valid relay MAC cannot cross org boundaries', wrongOrgRelayErrors.includes('internal relay key org mismatch'), wrongOrgRelayErrors);
const skewedRelay = clone(observation);
skewedRelay.relay.internalAuth.timestamp = '2026-08-24T03:50:00Z';
skewedRelay.relay.replayReceipt.acceptedAt = '2026-08-24T03:50:00Z';
skewedRelay.relay.replayReceipt.expiresAt = '2026-08-24T03:55:00Z';
rehashRelayFixture(skewedRelay, relayTestSecrets.secretsByKeyId['cortext-relay-key-v1']);
const skewedRelayErrors = validateObservation(skewedRelay, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-054', 'relay authorization timestamp is skew-bounded', skewedRelayErrors.includes('relay auth timestamp skew'), skewedRelayErrors);
const replaySubstitution = clone(observation);
replaySubstitution.relay.internalAuth.nonce = 'attacker_nonce_0000001';
rehashRelayFixture(replaySubstitution, relayTestSecrets.secretsByKeyId['cortext-relay-key-v1'], false);
const replaySubstitutionErrors = validateObservation(replaySubstitution, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-055', 'relay nonce must match the replay-store receipt', replaySubstitutionErrors.includes('relay replay receipt binding mismatch'), replaySubstitutionErrors);
const wrongRelaySecretErrors = validateObservation(observation, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, { ...relayTestSecrets, secretsByKeyId: { 'cortext-relay-key-v1': 'wrong-relay-secret' } }, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-056', 'relay MAC validates against configured secret by key ID', wrongRelaySecretErrors.includes('relay HMAC mismatch'), wrongRelaySecretErrors);

recordG4Positive('G4-P-002', 'exact Fireflies header, scheme, lowercase signature, configured secret, and raw body pass', validateFirefliesVectors(firefliesVectors, observation, firefliesTestSecrets));
const firefliesAttack = (id, expected, mutate) => {
  const attacked = clone(firefliesVectors);
  const valid = attacked.vectors.find((vector) => vector.expected === 'accept');
  mutate(valid);
  const errors = validateFirefliesVectors(attacked, null, firefliesTestSecrets);
  recordAttack(id, expected, errors.includes('Fireflies vector mismatch: valid-raw-body'), errors);
};
firefliesAttack('A-057', 'Fireflies requires exact X-Hub-Signature header', (vector) => { vector.headerName = 'Authorization'; });
firefliesAttack('A-058', 'Fireflies requires exact sha256= prefix', (vector) => { vector.headerValue = vector.headerValue.replace('sha256=', 'hmac='); });
firefliesAttack('A-059', 'Fireflies rejects non-hex signatures', (vector) => { vector.headerValue = `sha256=${'g'.repeat(64)}`; });
firefliesAttack('A-060', 'Fireflies rejects uppercase signature hex', (vector) => { vector.headerValue = vector.headerValue.toUpperCase(); });
firefliesAttack('A-061', 'Fireflies validates against the configured secret', (vector) => { vector.headerValue = 'sha256=7241c4537b54fc2d0f0ad221d39db8d097e3e251035a385a14978e849326b74b'; });
firefliesAttack('A-062', 'Fireflies signs unmodified raw-body bytes', (vector) => { vector.rawBodyUtf8 = `{ ${vector.rawBodyUtf8.slice(1, -1)} }`; });
firefliesAttack('A-063', 'Fireflies rejects unsupported signature schemes', (vector) => { vector.scheme = 'sha256-body-digest'; });

const pendingObservation = clone(observation);
Object.assign(pendingObservation.relay, {
  state: 'RELAY_PENDING', relayReceiptDigest: null, internalAuth: null, replayReceipt: null,
  previousState: null, attempt: 0, leaseVersion: 0, firstAttemptAt: null, deadlineAt: null,
  leaseOwner: null, leaseExpiresAt: null, lastUpdatedAt: pendingObservation.relay.durableReceipt.persistedAt,
  errorCode: null,
});
pendingObservation.observationDigest = digestWithout(pendingObservation, 'observationDigest');
recordG4Positive('G4-P-007', 'durably persisted RELAY_PENDING is representable without success-only auth or replay receipts', validateObservation(pendingObservation, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest));
const leasedObservation = clone(pendingObservation);
Object.assign(leasedObservation.relay, {
  state: 'LEASED', previousState: 'RELAY_PENDING', attempt: 1, leaseVersion: 1,
  firstAttemptAt: '2026-08-24T04:00:02Z', deadlineAt: '2026-08-24T04:15:02Z',
  leaseOwner: 'cortext:fireflies-relay', leaseExpiresAt: '2026-08-24T04:01:02Z',
  lastUpdatedAt: '2026-08-24T04:00:02Z',
});
leasedObservation.observationDigest = digestWithout(leasedObservation, 'observationDigest');
recordG4Positive('G4-P-008', 'LEASED is representable after durable persistence and before completed auth/replay acceptance', validateObservation(leasedObservation, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest));
recordG4Positive('G4-P-009', 'Fireflies verification config is externally pinned with a valid active key and rotation window', validateFirefliesVerificationConfig(firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest));

const pendingWithSuccessReceipt = clone(pendingObservation);
pendingWithSuccessReceipt.relay.internalAuth = clone(observation.relay.internalAuth);
pendingWithSuccessReceipt.relay.replayReceipt = clone(observation.relay.replayReceipt);
pendingWithSuccessReceipt.relay.relayReceiptDigest = observation.relay.relayReceiptDigest;
pendingWithSuccessReceipt.observationDigest = digestWithout(pendingWithSuccessReceipt, 'observationDigest');
const pendingWithSuccessErrors = validateObservation(pendingWithSuccessReceipt, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-119', 'pending relay state cannot carry accepted_new success receipts', pendingWithSuccessErrors.includes('pre-success relay state carries success receipt') && pendingWithSuccessErrors.includes('schema validation failed'), pendingWithSuccessErrors);
const relayedWithoutReplay = clone(observation);
relayedWithoutReplay.relay.replayReceipt = null;
relayedWithoutReplay.observationDigest = digestWithout(relayedWithoutReplay, 'observationDigest');
const relayedWithoutReplayErrors = validateObservation(relayedWithoutReplay, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-120', 'RELAYED requires completed auth and replay acceptance receipts', relayedWithoutReplayErrors.includes('relayed observation lacks completed auth/replay receipt'), relayedWithoutReplayErrors);
const pendingWithoutDurable = clone(pendingObservation);
delete pendingWithoutDurable.relay.durableReceipt;
pendingWithoutDurable.observationDigest = digestWithout(pendingWithoutDurable, 'observationDigest');
const pendingWithoutDurableErrors = validateObservation(pendingWithoutDurable, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-121', 'relay cannot begin before a durable observation receipt exists', pendingWithoutDurableErrors.includes('relay durable observation receipt missing'), pendingWithoutDurableErrors);
const unpinnedVerificationConfig = clone(firefliesVerificationConfig);
unpinnedVerificationConfig.configVersion = 'attacker-self-consistent-v2';
unpinnedVerificationConfig.configDigest = firefliesVerificationConfigDigest(unpinnedVerificationConfig);
const unpinnedConfigObservation = clone(observation);
unpinnedConfigObservation.signatureVerification.keyConfigVersion = unpinnedVerificationConfig.configVersion;
unpinnedConfigObservation.signatureVerification.verificationConfigDigest = unpinnedVerificationConfig.configDigest;
rehashObservationVerification(unpinnedConfigObservation);
const unpinnedConfigErrors = validateObservation(unpinnedConfigObservation, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, unpinnedVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-122', 'self-consistent provider verification config cannot replace deployment trust', unpinnedConfigErrors.includes('Fireflies verification config not deployment trusted'), unpinnedConfigErrors);
const expiredVerificationObservation = clone(observation);
expiredVerificationObservation.signatureVerification.verifiedAt = '2028-01-01T00:00:00Z';
rehashObservationVerification(expiredVerificationObservation);
const expiredVerificationErrors = validateObservation(expiredVerificationObservation, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-123', 'provider verification time must fall inside pinned config and key validity', expiredVerificationErrors.includes('provider verification outside configured validity'), expiredVerificationErrors);
const substitutedProviderKey = clone(observation);
substitutedProviderKey.signatureVerification.keyId = 'attacker-provider-key';
rehashObservationVerification(substitutedProviderKey);
const substitutedProviderKeyErrors = validateObservation(substitutedProviderKey, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-124', 'provider verification key ID must be authorized by pinned config', substitutedProviderKeyErrors.includes('provider verification config binding mismatch'), substitutedProviderKeyErrors);
const preReceiptPersistence = clone(observation);
preReceiptPersistence.relay.durableReceipt.persistedAt = '2026-08-24T03:59:59Z';
preReceiptPersistence.relay.durableReceipt.receiptDigest = digestWithout(preReceiptPersistence.relay.durableReceipt, 'receiptDigest');
preReceiptPersistence.observationDigest = digestWithout(preReceiptPersistence, 'observationDigest');
const preReceiptPersistenceErrors = validateObservation(preReceiptPersistence, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-125', 'durable persistence cannot precede receipt and provider verification', preReceiptPersistenceErrors.includes('relay durable chronology invalid'), preReceiptPersistenceErrors);
const prePersistAttempt = clone(observation);
prePersistAttempt.relay.firstAttemptAt = '2026-08-24T04:00:00Z';
prePersistAttempt.observationDigest = digestWithout(prePersistAttempt, 'observationDigest');
const prePersistAttemptErrors = validateObservation(prePersistAttempt, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-126', 'relay first attempt cannot precede durable persistence', prePersistAttemptErrors.includes('relay attempt chronology invalid'), prePersistAttemptErrors);
const backwardRelayUpdate = clone(observation);
backwardRelayUpdate.relay.lastUpdatedAt = '2026-08-24T04:00:00Z';
backwardRelayUpdate.observationDigest = digestWithout(backwardRelayUpdate, 'observationDigest');
const backwardRelayUpdateErrors = validateObservation(backwardRelayUpdate, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-127', 'relay last update cannot precede persistence or first attempt', backwardRelayUpdateErrors.includes('relay durable chronology invalid') || backwardRelayUpdateErrors.includes('relay attempt chronology invalid'), backwardRelayUpdateErrors);
const invertedRelayDeadline = clone(observation);
invertedRelayDeadline.relay.deadlineAt = '2026-08-24T04:00:05Z';
invertedRelayDeadline.observationDigest = digestWithout(invertedRelayDeadline, 'observationDigest');
const invertedRelayDeadlineErrors = validateObservation(invertedRelayDeadline, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-128', 'relay deadline cannot precede last update', invertedRelayDeadlineErrors.includes('relay attempt chronology invalid'), invertedRelayDeadlineErrors);
const expiredRelayLease = clone(observation);
expiredRelayLease.relay.leaseExpiresAt = '2026-08-24T04:00:05Z';
expiredRelayLease.observationDigest = digestWithout(expiredRelayLease, 'observationDigest');
const expiredRelayLeaseErrors = validateObservation(expiredRelayLease, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-129', 'relay lease expiry cannot precede the state update', expiredRelayLeaseErrors.includes('relay lease chronology invalid'), expiredRelayLeaseErrors);
const replayBeforeAuth = clone(observation);
replayBeforeAuth.relay.replayReceipt.acceptedAt = '2026-08-24T04:00:00Z';
rehashRelayFixture(replayBeforeAuth, relayTestSecrets.secretsByKeyId['cortext-relay-key-v1']);
const replayBeforeAuthErrors = validateObservation(replayBeforeAuth, authorityRoot.relayInternalAuthKeyIds, authorityRoot.orgId, relayTestSecrets, firefliesVerificationConfig, runtimeTrustedFirefliesVerificationConfigDigest);
recordAttack('A-130', 'replay acceptance cannot precede relay authorization', replayBeforeAuthErrors.includes('relay replay chronology invalid') && replayBeforeAuthErrors.includes('relay replay window invalid'), replayBeforeAuthErrors);

const preRecordErrorByStage = {
  parse: ['INGRESS_PARSE_FAILED', 'PRE_RECORD_PARSE_FAILURE'],
  auth: ['INGRESS_AUTH_FAILED', 'PRE_RECORD_AUTH_FAILURE'],
  persist: ['INGRESS_PERSIST_FAILED', 'PRE_RECORD_PERSIST_FAILURE'],
};
const rehashPreRecordFailure = (fixture) => {
  fixture.sourceIdentity.sourceIdentityDigest = digestWithout(fixture.sourceIdentity, 'sourceIdentityDigest');
  fixture.piiSafeAlertReceipt.receiptDigest = digestWithout(fixture.piiSafeAlertReceipt, 'receiptDigest');
  if (fixture.encryptedQuarantine && fixture.deletionReceipt) {
    fixture.deletionReceipt.quarantineReferenceDigest = sha256(fixture.encryptedQuarantine.reference);
    fixture.deletionReceipt.receiptDigest = digestWithout(fixture.deletionReceipt, 'receiptDigest');
  }
  fixture.failureDigest = digestWithout(fixture, 'failureDigest');
  return fixture;
};
for (const [index, stage] of ['parse', 'auth', 'persist'].entries()) {
  const fixture = clone(preRecordIngressFailure);
  fixture.stage = stage;
  fixture.failureId = `pre-record-failure:fireflies:req-demo:${stage}`;
  fixture.errorCode = preRecordErrorByStage[stage][0];
  fixture.piiSafeAlertReceipt.errorCode = preRecordErrorByStage[stage][0];
  fixture.piiSafeAlertReceipt.summaryCode = preRecordErrorByStage[stage][1];
  fixture.authenticationState = stage === 'auth' ? 'unverified' : 'verified';
  if (stage === 'auth') {
    fixture.encryptedQuarantine = null;
    fixture.deletionReceipt = null;
  }
  rehashPreRecordFailure(fixture);
  recordG4Positive(`G4-P-00${3 + index}`, `${stage} failure is representable before an observation exists`, validatePreRecordIngressFailure(fixture));
}
recordG4Positive('G4-P-006', 'identity failure remains observation-bound after durable ingress', validateProcessingFailure(processingFailure, observation));
const overlongQuarantine = clone(preRecordIngressFailure);
overlongQuarantine.encryptedQuarantine.expiresAt = '2026-08-25T04:00:01Z';
overlongQuarantine.deletionReceipt.scheduledFor = overlongQuarantine.encryptedQuarantine.expiresAt;
overlongQuarantine.deletionReceipt.deletedAt = '2026-08-25T04:00:00Z';
rehashPreRecordFailure(overlongQuarantine);
const overlongQuarantineErrors = validatePreRecordIngressFailure(overlongQuarantine);
recordAttack('A-064', 'pre-record quarantine expires within 24 hours of receipt', overlongQuarantineErrors.includes('pre-record quarantine TTL invalid'), overlongQuarantineErrors);
const plaintextQuarantine = clone(preRecordIngressFailure);
plaintextQuarantine.encryptedQuarantine.reference = '/tmp/fireflies-raw-body.json';
rehashPreRecordFailure(plaintextQuarantine);
const plaintextQuarantineErrors = validatePreRecordIngressFailure(plaintextQuarantine);
recordAttack('A-065', 'pre-record bytes require an encrypted quarantine reference', plaintextQuarantineErrors.includes('pre-record quarantine is not encrypted'), plaintextQuarantineErrors);
const leakingAlert = clone(preRecordIngressFailure);
leakingAlert.piiSafeAlertReceipt.rawBodyIncluded = true;
rehashPreRecordFailure(leakingAlert);
const leakingAlertErrors = validatePreRecordIngressFailure(leakingAlert);
recordAttack('A-066', 'pre-record alert receipt cannot contain raw provider bytes', leakingAlertErrors.includes('pre-record alert leaks provider payload'), leakingAlertErrors);
const badDeletionReceipt = clone(preRecordIngressFailure);
badDeletionReceipt.deletionReceipt.quarantineReferenceDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
badDeletionReceipt.failureDigest = digestWithout(badDeletionReceipt, 'failureDigest');
const badDeletionErrors = validatePreRecordIngressFailure(badDeletionReceipt);
recordAttack('A-067', 'deletion receipt binds the encrypted quarantine reference', badDeletionErrors.includes('pre-record deletion receipt mismatch'), badDeletionErrors);
const observationBoundPreRecord = clone(preRecordIngressFailure);
observationBoundPreRecord.observationId = observation.observationId;
observationBoundPreRecord.failureDigest = digestWithout(observationBoundPreRecord, 'failureDigest');
const observationBoundPreRecordErrors = validatePreRecordIngressFailure(observationBoundPreRecord);
recordAttack('A-068', 'pre-record failures cannot claim a MeetingObservation identity', observationBoundPreRecordErrors.includes('schema validation failed'), observationBoundPreRecordErrors);
const ingressInProcessingContract = clone(processingFailure);
ingressInProcessingContract.stage = 'ingress_persist';
ingressInProcessingContract.failureDigest = digestWithout(ingressInProcessingContract, 'failureDigest');
const ingressInProcessingErrors = validateProcessingFailure(ingressInProcessingContract, observation);
recordAttack('A-069', 'MeetingProcessingFailure cannot represent pre-observation persistence failure', ingressInProcessingErrors.includes('pre-record failure uses observation-bound contract'), ingressInProcessingErrors);
const parseIdentityDrift = clone(preRecordIngressFailure);
parseIdentityDrift.stage = 'parse';
parseIdentityDrift.errorCode = 'INGRESS_PARSE_FAILED';
parseIdentityDrift.piiSafeAlertReceipt.errorCode = 'INGRESS_PARSE_FAILED';
parseIdentityDrift.piiSafeAlertReceipt.summaryCode = 'PRE_RECORD_PARSE_FAILURE';
parseIdentityDrift.sourceIdentity.requestId = 'request:attacker-substitution';
parseIdentityDrift.piiSafeAlertReceipt.receiptDigest = digestWithout(parseIdentityDrift.piiSafeAlertReceipt, 'receiptDigest');
parseIdentityDrift.failureDigest = digestWithout(parseIdentityDrift, 'failureDigest');
const parseIdentityDriftErrors = validatePreRecordIngressFailure(parseIdentityDrift);
recordAttack('A-070', 'parse failure binds source/request digest identity', parseIdentityDriftErrors.includes('pre-record source identity mismatch'), parseIdentityDriftErrors);
const authStageMismatch = clone(preRecordIngressFailure);
authStageMismatch.stage = 'auth';
authStageMismatch.failureDigest = digestWithout(authStageMismatch, 'failureDigest');
const authStageMismatchErrors = validatePreRecordIngressFailure(authStageMismatch);
recordAttack('A-071', 'auth failure binds its PII-safe code and summary', authStageMismatchErrors.includes('pre-record stage/error binding mismatch'), authStageMismatchErrors);
const identityObservationMismatch = clone(processingFailure);
identityObservationMismatch.observationDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
identityObservationMismatch.failureDigest = digestWithout(identityObservationMismatch, 'failureDigest');
const identityObservationMismatchErrors = validateProcessingFailure(identityObservationMismatch, observation);
recordAttack('A-072', 'identity failure binds an already persisted observation', identityObservationMismatchErrors.includes('processing failure/observation binding mismatch'), identityObservationMismatchErrors);

const authWithQuarantine = clone(preRecordIngressFailure);
authWithQuarantine.stage = 'auth';
authWithQuarantine.authenticationState = 'unverified';
authWithQuarantine.errorCode = 'INGRESS_AUTH_FAILED';
authWithQuarantine.piiSafeAlertReceipt.errorCode = 'INGRESS_AUTH_FAILED';
authWithQuarantine.piiSafeAlertReceipt.summaryCode = 'PRE_RECORD_AUTH_FAILURE';
rehashPreRecordFailure(authWithQuarantine);
const authWithQuarantineErrors = validatePreRecordIngressFailure(authWithQuarantine);
recordAttack('A-131', 'unauthenticated auth failure cannot retain encrypted quarantine or deletion state', authWithQuarantineErrors.includes('auth failure retained unauthenticated provider body'), authWithQuarantineErrors);
const parseWithoutQuarantine = clone(preRecordIngressFailure);
parseWithoutQuarantine.stage = 'parse';
parseWithoutQuarantine.errorCode = 'INGRESS_PARSE_FAILED';
parseWithoutQuarantine.piiSafeAlertReceipt.errorCode = 'INGRESS_PARSE_FAILED';
parseWithoutQuarantine.piiSafeAlertReceipt.summaryCode = 'PRE_RECORD_PARSE_FAILURE';
parseWithoutQuarantine.encryptedQuarantine = null;
parseWithoutQuarantine.deletionReceipt = null;
rehashPreRecordFailure(parseWithoutQuarantine);
const parseWithoutQuarantineErrors = validatePreRecordIngressFailure(parseWithoutQuarantine);
recordAttack('A-132', 'authenticated parse failure requires encrypted quarantine and deletion state', parseWithoutQuarantineErrors.includes('authenticated pre-record failure lacks quarantine/deletion'), parseWithoutQuarantineErrors);
const persistWithoutDeletion = clone(preRecordIngressFailure);
persistWithoutDeletion.deletionReceipt = null;
rehashPreRecordFailure(persistWithoutDeletion);
const persistWithoutDeletionErrors = validatePreRecordIngressFailure(persistWithoutDeletion);
recordAttack('A-133', 'authenticated persist failure requires deletion state', persistWithoutDeletionErrors.includes('authenticated pre-record failure lacks quarantine/deletion'), persistWithoutDeletionErrors);
const alertBeforeFailure = clone(preRecordIngressFailure);
alertBeforeFailure.piiSafeAlertReceipt.createdAt = '2026-08-24T04:00:00Z';
rehashPreRecordFailure(alertBeforeFailure);
const alertBeforeFailureErrors = validatePreRecordIngressFailure(alertBeforeFailure);
recordAttack('A-134', 'pre-record alert cannot precede the failure it reports', alertBeforeFailureErrors.includes('pre-record failure/alert chronology invalid'), alertBeforeFailureErrors);
const deletionBeforeSchedule = clone(preRecordIngressFailure);
deletionBeforeSchedule.deletionReceipt.deletedAt = '2026-08-25T03:59:59Z';
rehashPreRecordFailure(deletionBeforeSchedule);
const deletionBeforeScheduleErrors = validatePreRecordIngressFailure(deletionBeforeSchedule);
recordAttack('A-135', 'quarantine deletion cannot precede its scheduled deletion time', deletionBeforeScheduleErrors.includes('pre-record deletion state invalid'), deletionBeforeScheduleErrors);
const unverifiedParseFailure = clone(preRecordIngressFailure);
unverifiedParseFailure.stage = 'parse';
unverifiedParseFailure.authenticationState = 'unverified';
unverifiedParseFailure.errorCode = 'INGRESS_PARSE_FAILED';
unverifiedParseFailure.piiSafeAlertReceipt.errorCode = 'INGRESS_PARSE_FAILED';
unverifiedParseFailure.piiSafeAlertReceipt.summaryCode = 'PRE_RECORD_PARSE_FAILURE';
rehashPreRecordFailure(unverifiedParseFailure);
const unverifiedParseErrors = validatePreRecordIngressFailure(unverifiedParseFailure);
recordAttack('A-136', 'parse/persist quarantine is valid only after successful provider authentication', unverifiedParseErrors.includes('authenticated pre-record failure lacks quarantine/deletion'), unverifiedParseErrors);

const exactOperationVectors = [
  ['upsert_account', 'account', 'accountId', crmProjection.accounts[0]],
  ['upsert_contact', 'contact', 'contactId', crmProjection.contacts[0]],
  ['upsert_engagement', 'engagement', 'engagementId', crmProjection.engagements[0]],
  ['upsert_interaction', 'interaction', 'interactionId', crmProjection.interactions[0]],
  ['upsert_lifecycle', 'lifecycle', 'lifecycleId', crmProjection.lifecycleItems[0]],
];
const exactOperationPositiveResults = [];
const exactValueField = { account: 'name', contact: 'displayName', engagement: 'name', interaction: 'title', lifecycle: 'workState' };
for (const [vectorIndex, [operation, entityType, idField, sourceRow]] of exactOperationVectors.entries()) {
  const request = clone(intentRequest);
  request.operation = operation;
  request.target = { entityType, entityId: sourceRow[idField] };
  const runtimeOnly = new Set(['version', 'digest', 'updatedAt', ...(entityType === 'interaction' ? ['canonicalMeetingId', 'recordDigest'] : [])]);
  request.proposedValue = Object.fromEntries(Object.entries(sourceRow).filter(([key]) => !runtimeOnly.has(key)));
  request.proposedValueDigest = sha256(jcs(request.proposedValue));
  request.clientRequestId = `briefs:req:${entityType}:vector`;
  request.idempotencyKey = `meeting_demo_2026_08_24_01:v1:crm:${entityType}:vector`;
  request.requestDigest = crmIntentRequestDigest(request);
  const durable = clone(intent);
  for (const field of Object.keys(request)) if (field !== 'schemaVersion') durable[field] = clone(request[field]);
  durable.intentId = `crm:intent:${entityType}:vector`;
  durable.previousIntentDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  durable.intentDigest = crmIntentDigest(durable);
  const makeVectorWriteSet = (candidateDurable) => {
    const candidateWriteSet = {
      schemaVersion: '1.0',
      orgId: record.orgId,
      writeSetId: `${record.canonicalMeetingId}:v${record.recordVersion}:crm-write-set:vector:${entityType}`,
      writeSetDigest: '',
      canonicalMeetingId: record.canonicalMeetingId,
      recordVersion: record.recordVersion,
      recordDigest: record.recordDigest,
      expectedWrites: [Object.fromEntries(EXPECTED_INTENT_FIELDS.map((field) => [field, clone(candidateDurable[field])]))],
    };
    candidateWriteSet.writeSetDigest = crmWriteSetDigest(candidateWriteSet);
    return candidateWriteSet;
  };
  const vectorWriteSet = makeVectorWriteSet(durable);
  const vectorDelivery = clone(delivery);
  const embeddedKeys = Object.keys(vectorDelivery.crm.writeIntents[0]);
  vectorDelivery.crm.writeIntents = [Object.fromEntries(embeddedKeys.map((field) => [field, clone(durable[field])]))];
  vectorDelivery.crm.writeSetId = vectorWriteSet.writeSetId;
  vectorDelivery.crm.writeSetDigest = vectorWriteSet.writeSetDigest;
  vectorDelivery.manifestDigest = deliveryManifestDigest(vectorDelivery);
  const vectorBriefsReadback = clone(briefsReadback);
  vectorBriefsReadback.manifestDigest = vectorDelivery.manifestDigest;
  vectorBriefsReadback.envelopeReadbackDigest = sha256(jcs({ canonicalMeetingId: vectorDelivery.canonicalMeetingId, manifestRevision: vectorDelivery.manifestRevision, manifestDigest: vectorDelivery.manifestDigest }));
  vectorBriefsReadback.readbackDigest = digestWithout(vectorBriefsReadback, 'readbackDigest');
  const vectorAck = clone(replicationAck);
  vectorAck.manifestDigest = vectorDelivery.manifestDigest;
  vectorAck.readbackDigest = vectorBriefsReadback.readbackDigest;
  vectorAck.ackDigest = digestWithout(vectorAck, 'ackDigest');
  const validateVectorEndToEnd = (candidateRequest, candidateDurable) => {
    const candidateWriteSet = makeVectorWriteSet(candidateDurable);
    const candidateDelivery = clone(vectorDelivery);
    candidateDelivery.crm.writeIntents = [Object.fromEntries(embeddedKeys.map((field) => [field, clone(candidateDurable[field])]))];
    candidateDelivery.crm.writeSetId = candidateWriteSet.writeSetId;
    candidateDelivery.crm.writeSetDigest = candidateWriteSet.writeSetDigest;
    candidateDelivery.manifestDigest = deliveryManifestDigest(candidateDelivery);
    const candidateBriefs = clone(briefsReadback);
    candidateBriefs.manifestDigest = candidateDelivery.manifestDigest;
    candidateBriefs.envelopeReadbackDigest = sha256(jcs({ canonicalMeetingId: candidateDelivery.canonicalMeetingId, manifestRevision: candidateDelivery.manifestRevision, manifestDigest: candidateDelivery.manifestDigest }));
    candidateBriefs.readbackDigest = digestWithout(candidateBriefs, 'readbackDigest');
    const candidateAck = clone(replicationAck);
    candidateAck.manifestDigest = candidateDelivery.manifestDigest;
    candidateAck.readbackDigest = candidateBriefs.readbackDigest;
    candidateAck.ackDigest = digestWithout(candidateAck, 'ackDigest');
    return [...new Set([
      ...validateIntentRequest(candidateRequest),
      ...validateIntent(candidateDurable, candidateRequest, record, baseCrmProjection, crmProjection),
      ...validateDelivery(candidateDelivery),
      ...validateSystemJoin({ record, delivery: candidateDelivery, crmProjection, baseCrmProjection, crmWriteSet: candidateWriteSet, crmIntentRequests: [candidateRequest], crmIntents: [candidateDurable], replicationAck: candidateAck, briefsReadback: candidateBriefs, dispositionSet, authorityRegistry, authorityRoot, trustedAuthorityRootDigest: runtimeTrustedAuthorityRootDigest, identityOverride }),
    ])];
  };
  const errors = [
    ...validateIntentRequest(request),
    ...validateIntent(durable, request, record, baseCrmProjection, crmProjection),
    ...validateDelivery(vectorDelivery),
    ...validateSystemJoin({ record, delivery: vectorDelivery, crmProjection, baseCrmProjection, crmWriteSet: vectorWriteSet, crmIntentRequests: [request], crmIntents: [durable], replicationAck: vectorAck, briefsReadback: vectorBriefsReadback, dispositionSet, authorityRegistry, authorityRoot, trustedAuthorityRootDigest: runtimeTrustedAuthorityRootDigest, identityOverride }),
  ];
  exactOperationPositiveResults.push({ operation, pass: errors.length === 0, errors: [...new Set(errors)] });
  if (errors.length) positiveErrors.push(...errors.map((error) => `exact operation ${operation}: ${error}`));

  const mismatchedOperationRequest = clone(request);
  mismatchedOperationRequest.operation = exactOperationVectors[(vectorIndex + 1) % exactOperationVectors.length][0];
  mismatchedOperationRequest.requestDigest = crmIntentRequestDigest(mismatchedOperationRequest);
  const mismatchedOperation = clone(durable);
  mismatchedOperation.operation = mismatchedOperationRequest.operation;
  mismatchedOperation.requestDigest = mismatchedOperationRequest.requestDigest;
  mismatchedOperation.intentDigest = crmIntentDigest(mismatchedOperation);
  const operationErrors = validateVectorEndToEnd(mismatchedOperationRequest, mismatchedOperation);
  recordAttack(`A-${String(16 + vectorIndex * 4).padStart(3, '0')}`, `${operation} rejects a mismatched operation/entity pair`, operationErrors.includes('CRM exact operation/target mismatch'), operationErrors);

  const mismatchedTargetRequest = clone(request);
  mismatchedTargetRequest.target.entityId = `crm:${entityType}:attacker-missing`;
  mismatchedTargetRequest.requestDigest = crmIntentRequestDigest(mismatchedTargetRequest);
  const mismatchedTarget = clone(durable);
  mismatchedTarget.target = clone(mismatchedTargetRequest.target);
  mismatchedTarget.requestDigest = mismatchedTargetRequest.requestDigest;
  mismatchedTarget.intentDigest = crmIntentDigest(mismatchedTarget);
  const targetErrors = validateVectorEndToEnd(mismatchedTargetRequest, mismatchedTarget);
  recordAttack(`A-${String(17 + vectorIndex * 4).padStart(3, '0')}`, `${operation} requires its exact target row`, targetErrors.includes('applied intent target readback missing'), targetErrors);

  const mismatchedValueRequest = clone(request);
  const valueField = exactValueField[entityType];
  mismatchedValueRequest.proposedValue[valueField] = entityType === 'lifecycle' ? 'waiting' : `${mismatchedValueRequest.proposedValue[valueField]} attacker`;
  mismatchedValueRequest.proposedValueDigest = sha256(jcs(mismatchedValueRequest.proposedValue));
  mismatchedValueRequest.requestDigest = crmIntentRequestDigest(mismatchedValueRequest);
  const mismatchedValue = clone(durable);
  mismatchedValue.proposedValue = clone(mismatchedValueRequest.proposedValue);
  mismatchedValue.proposedValueDigest = mismatchedValueRequest.proposedValueDigest;
  mismatchedValue.requestDigest = mismatchedValueRequest.requestDigest;
  mismatchedValue.intentDigest = crmIntentDigest(mismatchedValue);
  const valueErrors = validateVectorEndToEnd(mismatchedValueRequest, mismatchedValue);
  recordAttack(`A-${String(18 + vectorIndex * 4).padStart(3, '0')}`, `${operation} requires byte-equivalent proposed-value readback`, valueErrors.includes('applied intent readback content mismatch'), valueErrors);

  const mismatchedReadback = clone(durable);
  mismatchedReadback.authoritativeReadbackDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  mismatchedReadback.intentDigest = crmIntentDigest(mismatchedReadback);
  const readbackErrors = validateVectorEndToEnd(request, mismatchedReadback);
  recordAttack(`A-${String(19 + vectorIndex * 4).padStart(3, '0')}`, `${operation} requires the authoritative current projection readback`, readbackErrors.includes('applied intent readback binding mismatch'), readbackErrors);
}
const derived = deriveSystemState(joinedInput);
const completedDelivery = clone(delivery);
const completedSourceKey = `meeting:${record.canonicalMeetingId}:v${record.recordVersion}:pa:normal_completion`;
completedDelivery.paDeliveryReceipt = {
  sink: 'pa_telegram', notificationKind: 'normal_completion', sourceKey: completedSourceKey, outboundDigest: '8080808080808080808080808080808080808080808080808080808080808080', consequentialDeltaDigest: consequentialDeltaDigest(record), providerMessageId: '1903', correctsProviderMessageId: null, policyVersion: 'pa-notification-v1', linkKind: 'meeting_record', durablePath: `/business/crm/meetings/${record.canonicalMeetingId}`, failedSink: null, idempotencyKey: `${record.orgId}:${completedSourceKey}`, state: 'SUCCEEDED', attempt: 1, leaseVersion: 1, previousState: 'LEASED', firstAttemptAt: '2026-08-24T04:01:45Z', deadlineAt: '2026-08-24T04:16:45Z', nextAttemptAt: null, unknownProbeCount: 0, lastProbeAt: null, leaseOwner: 'meeting-engine:demo', leaseExpiresAt: '2026-08-24T04:03:00Z', readbackVersion: 'telegram:1903', readbackObjectDigest: sha256(jcs({ providerMessageId: '1903', outboundDigest: '8080808080808080808080808080808080808080808080808080808080808080' })), recordDigest: record.recordDigest, readbackDigest: null, updatedAt: '2026-08-24T04:02:00Z', errorCode: null, reconciliationReceipt: null,
};
completedDelivery.paDeliveryReceipt.readbackDigest = paReadbackDigest(completedDelivery.paDeliveryReceipt);
completedDelivery.manifestDigest = deliveryManifestDigest(completedDelivery);
const completedBriefsReadback = clone(briefsReadback);
completedBriefsReadback.manifestDigest = completedDelivery.manifestDigest;
completedBriefsReadback.envelopeReadbackDigest = sha256(jcs({ canonicalMeetingId: completedDelivery.canonicalMeetingId, manifestRevision: completedDelivery.manifestRevision, manifestDigest: completedDelivery.manifestDigest }));
completedBriefsReadback.readbackDigest = digestWithout(completedBriefsReadback, 'readbackDigest');
const completedAck = clone(replicationAck);
completedAck.manifestDigest = completedDelivery.manifestDigest;
completedAck.readbackDigest = completedBriefsReadback.readbackDigest;
completedAck.ackDigest = digestWithout(completedAck, 'ackDigest');
const completedState = deriveSystemState({ ...joinedInput, delivery: completedDelivery, briefsReadback: completedBriefsReadback, replicationAck: completedAck });
if (!completedState.notificationComplete || !completedState.overallComplete) positiveErrors.push('normal completion binding scenario mismatch');

// G5: a correction is a new delivery receipt joined to the actual predecessor
// notification and deterministic record delta, not an arbitrary message ID.
const bindReadbackToDelivery = (candidateDelivery) => {
  const candidateBriefs = clone(briefsReadback);
  candidateBriefs.manifestRevision = candidateDelivery.manifestRevision;
  candidateBriefs.manifestDigest = candidateDelivery.manifestDigest;
  candidateBriefs.envelopeReadbackDigest = sha256(jcs({ canonicalMeetingId: candidateDelivery.canonicalMeetingId, manifestRevision: candidateDelivery.manifestRevision, manifestDigest: candidateDelivery.manifestDigest }));
  candidateBriefs.readbackDigest = digestWithout(candidateBriefs, 'readbackDigest');
  const candidateAck = clone(replicationAck);
  candidateAck.manifestRevision = candidateDelivery.manifestRevision;
  candidateAck.manifestDigest = candidateDelivery.manifestDigest;
  candidateAck.readbackDigest = candidateBriefs.readbackDigest;
  candidateAck.ackDigest = digestWithout(candidateAck, 'ackDigest');
  return { candidateBriefs, candidateAck };
};
const correctedRecord = clone(nextRecord);
correctedRecord.semanticViews.consequentialDeltaClaimIds = [...new Set([...correctedRecord.semanticViews.consequentialDeltaClaimIds, correctedRecord.semanticViews.opportunityClaimIds[0]])];
correctedRecord.recordDigest = recordDigest(correctedRecord);
const correctionDelivery = clone(completedDelivery);
correctionDelivery.manifestRevision += 1;
correctionDelivery.previousManifestDigest = completedDelivery.manifestDigest;
correctionDelivery.recordVersion = correctedRecord.recordVersion;
correctionDelivery.recordDigest = correctedRecord.recordDigest;
for (const receipt of correctionDelivery.upstreamReceipts) {
  receipt.recordDigest = correctedRecord.recordDigest;
  if (receipt.state === 'SUCCEEDED') receipt.readbackDigest = sinkReadbackDigest(receipt);
}
const priorPaReceipt = completedDelivery.paDeliveryReceipt;
const correctionSourceKey = `meeting:${correctedRecord.canonicalMeetingId}:v${correctedRecord.recordVersion}:pa:correction`;
correctionDelivery.paDeliveryReceipt = {
  ...clone(priorPaReceipt),
  notificationKind: 'correction',
  sourceKey: correctionSourceKey,
  outboundDigest: '8383838383838383838383838383838383838383838383838383838383838383',
  consequentialDeltaDigest: consequentialDeltaDigest(correctedRecord),
  correctionDeltaDigest: meetingRecordDeltaDigest(record, correctedRecord),
  providerMessageId: '1904',
  correctsProviderMessageId: priorPaReceipt.providerMessageId,
  predecessorReceiptDigest: priorPaReceipt.readbackDigest,
  predecessorSourceKey: priorPaReceipt.sourceKey,
  predecessorProviderMessageId: priorPaReceipt.providerMessageId,
  idempotencyKey: `${correctedRecord.orgId}:${correctionSourceKey}`,
  recordDigest: correctedRecord.recordDigest,
  previousState: 'LEASED',
  readbackVersion: 'telegram:1904',
  readbackObjectDigest: sha256(jcs({ providerMessageId: '1904', outboundDigest: '8383838383838383838383838383838383838383838383838383838383838383' })),
  updatedAt: '2026-08-24T04:03:00Z',
  readbackDigest: null,
};
correctionDelivery.paDeliveryReceipt.readbackDigest = paReadbackDigest(correctionDelivery.paDeliveryReceipt);
correctionDelivery.manifestDigest = deliveryManifestDigest(correctionDelivery);
recordG5Positive('G5-P-001', 'PA correction joins predecessor/current MeetingRecords and deterministic typed delta fields', [...validateDelivery(correctionDelivery), ...validatePaReceiptBinding(correctionDelivery.paDeliveryReceipt, correctionDelivery, correctedRecord, priorPaReceipt, record)]);
const correctionAttack = (id, expected, mutate, expectedError) => {
  const attacked = clone(correctionDelivery);
  mutate(attacked.paDeliveryReceipt);
  attacked.paDeliveryReceipt.readbackDigest = paReadbackDigest(attacked.paDeliveryReceipt);
  attacked.manifestDigest = deliveryManifestDigest(attacked);
  const errors = [...validateDelivery(attacked), ...validatePaReceiptBinding(attacked.paDeliveryReceipt, attacked, correctedRecord, priorPaReceipt, record)];
  recordAttack(id, expected, errors.includes(expectedError), [...new Set(errors)]);
};
correctionAttack('A-073', 'PA correction rejects an unrelated predecessor provider message', (receipt) => { receipt.correctsProviderMessageId = 'attacker-unrelated-message'; }, 'PA correction predecessor message mismatch');
correctionAttack('A-074', 'PA correction rejects a substituted predecessor source key', (receipt) => { receipt.predecessorSourceKey = 'attacker:source'; }, 'PA correction predecessor receipt mismatch');
correctionAttack('A-075', 'PA correction rejects a substituted predecessor receipt digest', (receipt) => { receipt.predecessorReceiptDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'; }, 'PA correction predecessor receipt mismatch');
correctionAttack('A-076', 'PA correction rejects an arbitrary recomputed delta digest', (receipt) => { receipt.correctionDeltaDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'; receipt.consequentialDeltaDigest = receipt.correctionDeltaDigest; }, 'PA correction delta binding mismatch');
const manifestOnlyCorrectionErrors = validatePaReceiptBinding(correctionDelivery.paDeliveryReceipt, correctionDelivery, record, priorPaReceipt, record);
recordAttack('A-137', 'manifest-revision-only correction with identical predecessor/current record fails', manifestOnlyCorrectionErrors.includes('PA correction record transition missing'), manifestOnlyCorrectionErrors);

const paTerminalCarryForward = clone(completedDelivery);
paTerminalCarryForward.manifestRevision += 1;
paTerminalCarryForward.previousManifestDigest = completedDelivery.manifestDigest;
paTerminalCarryForward.manifestDigest = deliveryManifestDigest(paTerminalCarryForward);
recordG3Positive('G3-P-015', 'a successful PA receipt carries byte-identically across delivery revisions', [...validateDelivery(paTerminalCarryForward), ...validateDeliveryTransition(completedDelivery, paTerminalCarryForward)]);
const removedPaTerminal = clone(paTerminalCarryForward);
removedPaTerminal.paDeliveryReceipt = null;
removedPaTerminal.manifestDigest = deliveryManifestDigest(removedPaTerminal);
const removedPaTerminalErrors = validateDeliveryTransition(completedDelivery, removedPaTerminal);
recordAttack('A-116', 'a prior successful PA receipt cannot disappear', removedPaTerminalErrors.includes('PA terminal receipt removed'), removedPaTerminalErrors);
const malformedCorrection = clone(correctionDelivery);
delete malformedCorrection.paDeliveryReceipt.predecessorReceiptDigest;
malformedCorrection.manifestDigest = deliveryManifestDigest(malformedCorrection);
const malformedCorrectionErrors = validateDeliveryTransition(completedDelivery, malformedCorrection);
recordAttack('A-117', 'a successful PA receipt may change only through a schema-valid bound correction', malformedCorrectionErrors.includes('PA correction schema invalid'), malformedCorrectionErrors);

const paUnknownLineage = clone(completedDelivery);
Object.assign(paUnknownLineage.paDeliveryReceipt, {
  state: 'UNKNOWN_COMMIT', previousState: 'LEASED', providerMessageId: null,
  readbackVersion: null, readbackObjectDigest: null, readbackDigest: null,
  unknownProbeCount: 1, lastProbeAt: '2026-08-24T04:02:00Z',
  updatedAt: '2026-08-24T04:02:00Z', nextAttemptAt: null, reconciliationReceipt: null,
});
paUnknownLineage.manifestDigest = deliveryManifestDigest(paUnknownLineage);
const reconciledPaSuccess = clone(paUnknownLineage);
reconciledPaSuccess.manifestRevision += 1;
reconciledPaSuccess.previousManifestDigest = paUnknownLineage.manifestDigest;
Object.assign(reconciledPaSuccess.paDeliveryReceipt, clone(completedDelivery.paDeliveryReceipt), {
  previousState: 'UNKNOWN_COMMIT', updatedAt: '2026-08-24T04:03:00Z', reconciliationReceipt: null,
});
reconciledPaSuccess.paDeliveryReceipt.reconciliationReceipt = buildAttemptReconciliation(paUnknownLineage.paDeliveryReceipt, reconciledPaSuccess.paDeliveryReceipt, 'telegram-provider-reconcile-v1');
reconciledPaSuccess.manifestDigest = deliveryManifestDigest(reconciledPaSuccess);
recordG3Positive('G3-P-016', 'PA UNKNOWN_COMMIT resolves only through a bound authoritative reconciliation receipt', [...validateDelivery(reconciledPaSuccess), ...validateDeliveryTransition(paUnknownLineage, reconciledPaSuccess)]);
const paUnknownToLease = clone(paUnknownLineage);
paUnknownToLease.manifestRevision += 1;
paUnknownToLease.previousManifestDigest = paUnknownLineage.manifestDigest;
Object.assign(paUnknownToLease.paDeliveryReceipt, {
  state: 'LEASED', previousState: 'UNKNOWN_COMMIT', leaseVersion: 2,
  unknownProbeCount: 0, lastProbeAt: null, updatedAt: '2026-08-24T04:03:00Z',
  leaseExpiresAt: '2026-08-24T04:04:00Z', reconciliationReceipt: null,
});
paUnknownToLease.manifestDigest = deliveryManifestDigest(paUnknownToLease);
const paUnknownToLeaseErrors = [...validateDelivery(paUnknownToLease), ...validateDeliveryTransition(paUnknownLineage, paUnknownToLease)];
recordAttack('A-118', 'PA UNKNOWN_COMMIT cannot re-enter LEASED', paUnknownToLeaseErrors.includes('PA UNKNOWN_COMMIT exit state invalid'), paUnknownToLeaseErrors);

recordG5Positive('G5-P-002', 'coverage freshness reduces against the governed authenticated evaluation clock', validateGovernedCoverage(coverage));
const rehashCoverageFixture = (fixture) => {
  fixture.enumerationAuthority.receiptDigest = sha256(jcs({ orgId: fixture.orgId, channels: fixture.channels, windowStart: fixture.windowStart, windowEnd: fixture.windowEnd, cutoffAt: fixture.cutoffAt, enumerationState: fixture.enumerationState, cursor: fixture.cursor, checkpointDigest: fixture.checkpointDigest, sourceIds: fixture.sourceIds, recordIds: fixture.recordIds, counts: fixture.counts, gaps: fixture.gaps, keyId: fixture.enumerationAuthority.keyId, policyVersion: fixture.enumerationAuthority.policyVersion }));
  fixture.freshness.receiptDigest = sha256(jcs({ coverageSnapshotId: fixture.coverageSnapshotId, evaluationClockDigest: fixture.evaluationClockDigest, generatedAt: fixture.generatedAt, cutoffAt: fixture.cutoffAt, policyVersion: fixture.freshness.policyVersion, evaluatedAsOf: fixture.freshness.evaluatedAsOf, state: fixture.freshness.state, snapshotAgeSeconds: fixture.freshness.snapshotAgeSeconds, sourceLagSeconds: fixture.freshness.sourceLagSeconds }));
  fixture.snapshotDigest = coverageSnapshotDigest(fixture);
  return fixture;
};
const stale2020Coverage = clone(coverage);
Object.assign(stale2020Coverage, { windowStart: '2020-01-01T00:00:00Z', windowEnd: '2020-01-01T00:59:00Z', cutoffAt: '2020-01-01T00:59:00Z', generatedAt: '2020-01-01T00:59:00Z' });
const attacker2020Clock = clone(coverageEvaluationClock);
attacker2020Clock.asOf = '2020-01-01T01:00:00Z';
attacker2020Clock.clockId = 'attacker-self-dated-2020';
attacker2020Clock.clockDigest = digestWithout(attacker2020Clock, 'clockDigest');
stale2020Coverage.evaluationClockDigest = attacker2020Clock.clockDigest;
Object.assign(stale2020Coverage.freshness, { evaluatedAsOf: attacker2020Clock.asOf, state: 'current', snapshotAgeSeconds: 60, sourceLagSeconds: 60 });
rehashCoverageFixture(stale2020Coverage);
const stale2020Errors = validateGovernedCoverage(stale2020Coverage);
recordAttack('A-077', 'internally ordered 2020 coverage is stale at the governed 2026 clock', stale2020Errors.includes('coverage snapshot stale at evaluation clock'), stale2020Errors);
const futureCoverage = clone(coverage);
futureCoverage.generatedAt = '2026-08-24T04:07:00Z';
rehashCoverageFixture(futureCoverage);
const futureCoverageErrors = validateGovernedCoverage(futureCoverage);
recordAttack('A-078', 'coverage generated after asOf fails as future', futureCoverageErrors.includes('coverage evaluated with future or inconsistent clock'), futureCoverageErrors);
const inconsistentFreshnessCoverage = clone(coverage);
inconsistentFreshnessCoverage.freshness.snapshotAgeSeconds = 999;
rehashCoverageFixture(inconsistentFreshnessCoverage);
const inconsistentFreshnessErrors = validateGovernedCoverage(inconsistentFreshnessCoverage);
recordAttack('A-079', 'caller-supplied freshness cannot contradict the reducer', inconsistentFreshnessErrors.includes('coverage freshness reducer mismatch'), inconsistentFreshnessErrors);
attacker2020Clock.issuedAt = '2020-01-01T00:59:59Z';
attacker2020Clock.authorityReceiptMacHex = hmacHex(coverageClockTestSecrets.secretsByKeyId[attacker2020Clock.authorityKeyId], coverageClockReceiptPayload(attacker2020Clock));
attacker2020Clock.clockDigest = digestWithout(attacker2020Clock, 'clockDigest');
stale2020Coverage.evaluationClockDigest = attacker2020Clock.clockDigest;
stale2020Coverage.freshness.evaluatedAsOf = attacker2020Clock.asOf;
rehashCoverageFixture(stale2020Coverage);
const fakeMatchingClockErrors = validateCoverage(stale2020Coverage, authorityRoot.coverageEnumeratorKeyIds, authorityRoot.orgId, attacker2020Clock, coverageClockAuthority, runtimeTrustedCoverageClockAuthorityDigest, coverageClockTestSecrets);
recordAttack('A-138', 'self-signed matching 2020 clock fails deployment-pinned authority validity', fakeMatchingClockErrors.includes('coverage clock authority chronology invalid'), fakeMatchingClockErrors);

recordG5Positive('G5-P-003', 'governed C aggregate and typed B sections derive from exact coverage membership and records', validateBriefsOutput(briefsOutput, record, coverage, coverageEvaluationClock, [record], delivery));
const briefsOutputAttack = (id, expected, mutate, expectedError) => {
  const attacked = clone(briefsOutput);
  mutate(attacked);
  attacked.outputDigest = digestWithout(attacked, 'outputDigest');
  const errors = validateBriefsOutput(attacked, record, coverage, coverageEvaluationClock, [record], delivery);
  recordAttack(id, expected, errors.includes(expectedError), errors);
};
briefsOutputAttack('A-080', 'C aggregate rejects arbitrary caller-supplied counts such as 999', (value) => { value.cSurface.numerator = 999; value.cSurface.denominator = 999; value.cSurface.rate = 1; }, 'Briefs aggregate numerator/denominator mismatch');
briefsOutputAttack('A-081', 'C ranking is derived from governed record movement', (value) => { value.cSurface.ranking[0].movementScore = 999; }, 'Briefs aggregate ranking derivation mismatch');
briefsOutputAttack('A-082', 'C card drill-through joins the governed B link identity', (value) => { value.cSurface.meetingCards[0].bPath = '/business/crm/meetings/attacker'; }, 'Briefs C-to-B drill-through mismatch');
briefsOutputAttack('A-083', 'B visibly labels fact, inference, and proposal', (value) => { value.bSurface.claimLabels = value.bSurface.claimLabels.filter((claim) => claim.label !== 'proposal'); }, 'Briefs claim labels incomplete');
briefsOutputAttack('A-084', 'B disposition label binds the underlying claim', (value) => { value.bSurface.claimLabels[1].disposition = 'accepted'; }, 'Briefs claim/disposition label binding mismatch');
briefsOutputAttack('A-085', 'B source evidence binds source lineage', (value) => { value.bSurface.sourceEvidence[0].sourceLineageDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'; }, 'Briefs source evidence binding mismatch');
briefsOutputAttack('A-086', 'B/C freshness binds the governed coverage reducer', (value) => { value.bSurface.freshnessState = 'stale'; }, 'Briefs rich-record binding mismatch');
briefsOutputAttack('A-139', 'C surface membership is bidirectionally equal to CoverageSnapshot records', (value) => { value.cSurface.drillThroughMeetingIds.push('meeting:attacker'); }, 'Briefs aggregate record membership mismatch');
briefsOutputAttack('A-140', 'typed rich B cannot omit a required section', (value) => { delete value.bSurface.sections.decisions; }, 'Briefs rich required section missing');
briefsOutputAttack('A-141', 'typed rich B claim references bind MeetingRecord semantic views', (value) => { value.bSurface.sections.discovery.needClaimIds = ['claim:attacker']; }, 'Briefs rich section claim reference mismatch');
briefsOutputAttack('A-142', 'typed rich B sink receipts bind the delivery envelope', (value) => { value.bSurface.sections.sinkReceiptsFreshness.sinks[0].state = 'TERMINAL_FAILED'; }, 'Briefs rich section sink receipt mismatch');

recordG5Positive('G5-P-004', 'stratified evaluator derives metrics from governed truth/prediction/evidence examples', validateSemanticEvaluation(semanticEvaluation, semanticDataset));
const semanticAttack = (id, expected, mutate, expectedError) => {
  const attacked = clone(semanticEvaluation);
  mutate(attacked);
  attacked.evaluationDigest = digestWithout(attacked, 'evaluationDigest');
  const errors = validateSemanticEvaluation(attacked, semanticDataset);
  recordAttack(id, expected, errors.includes(expectedError), errors);
};
semanticAttack('A-087', 'reported stratum membership cannot differ from governed dataset truth', (value) => { value.strata[0].positiveMeetingIds.pop(); }, 'semantic dataset stratum membership mismatch');
semanticAttack('A-088', 'reported confusion counts cannot differ from governed predictions', (value) => { Object.assign(value.strata[0], { falsePositive: 1, trueNegative: 7, precision: 8 / 9, accuracy: 15 / 16 }); }, 'semantic stratum confusion counts mismatch');
semanticAttack('A-089', 'meeting-level holdout forbids train/evaluation leakage', (value) => { value.meetingSplit.trainingMeetingIds.push(value.meetingSplit.evaluationMeetingIds[0]); value.meetingSplit.splitDigest = sha256(jcs({ policyVersion: value.meetingSplit.policyVersion, trainingMeetingIds: [...value.meetingSplit.trainingMeetingIds].sort(), evaluationMeetingIds: [...value.meetingSplit.evaluationMeetingIds].sort() })); }, 'semantic meeting-level split mismatch');
semanticAttack('A-090', 'every predeclared required dimension has a stratum', (value) => { value.strata.pop(); }, 'semantic required stratum missing');
semanticAttack('A-091', 'counterexample drill-through binds meeting and evidence', (value) => { value.counterexamples[0].drillThroughPath = '/business/crm/meetings/attacker'; }, 'semantic counterexample drill-through mismatch');
semanticAttack('A-092', 'every required stratum has a governed counterexample', (value) => { value.counterexamples = value.counterexamples.filter((item) => item.stratumId !== value.strata[0].stratumId); }, 'semantic stratum counterexample missing');
semanticAttack('A-093', 'per-stratum confidence is recomputed by deterministic Wilson z=1 lower bound', (value) => { value.strata[0].confidenceLowerBound = 0.5; }, 'semantic stratum metric mismatch');
const fabricatedTruthDataset = clone(semanticDataset);
fabricatedTruthDataset.examples[0].truth = false;
fabricatedTruthDataset.datasetDigest = digestWithout(fabricatedTruthDataset, 'datasetDigest');
const fabricatedTruthEvaluation = clone(semanticEvaluation);
fabricatedTruthEvaluation.datasetDigest = fabricatedTruthDataset.datasetDigest;
fabricatedTruthEvaluation.evaluationDigest = digestWithout(fabricatedTruthEvaluation, 'evaluationDigest');
const fabricatedTruthErrors = validateSemanticEvaluation(fabricatedTruthEvaluation, fabricatedTruthDataset);
recordAttack('A-143', 'fabricated truth labels invalidate recomputed membership and metrics', fabricatedTruthErrors.includes('semantic dataset stratum membership mismatch') && fabricatedTruthErrors.includes('semantic stratum confusion counts mismatch'), fabricatedTruthErrors);
const fabricatedEvidenceDataset = clone(semanticDataset);
fabricatedEvidenceDataset.examples[8].evidenceId = 'evidence:attacker';
fabricatedEvidenceDataset.datasetDigest = digestWithout(fabricatedEvidenceDataset, 'datasetDigest');
const fabricatedEvidenceEvaluation = clone(semanticEvaluation);
fabricatedEvidenceEvaluation.datasetDigest = fabricatedEvidenceDataset.datasetDigest;
fabricatedEvidenceEvaluation.evaluationDigest = digestWithout(fabricatedEvidenceEvaluation, 'evaluationDigest');
const fabricatedEvidenceErrors = validateSemanticEvaluation(fabricatedEvidenceEvaluation, fabricatedEvidenceDataset);
recordAttack('A-144', 'counterexample evidence must exist in governed evaluation examples', fabricatedEvidenceErrors.includes('semantic counterexample dataset evidence mismatch'), fabricatedEvidenceErrors);
const fabricatedConfidenceEvaluation = clone(semanticEvaluation);
fabricatedConfidenceEvaluation.strata[0].confidenceLowerBound = 0.999;
fabricatedConfidenceEvaluation.metricReceiptDigest = sha256(jcs({ attacker: true }));
fabricatedConfidenceEvaluation.evaluationDigest = digestWithout(fabricatedConfidenceEvaluation, 'evaluationDigest');
const fabricatedConfidenceErrors = validateSemanticEvaluation(fabricatedConfidenceEvaluation, semanticDataset);
recordAttack('A-145', 'fabricated confidence and metric receipts fail deterministic dataset recomputation', fabricatedConfidenceErrors.includes('semantic stratum metric mismatch') && fabricatedConfidenceErrors.includes('semantic metric receipt mismatch'), fabricatedConfidenceErrors);

const g2CorrectionPositiveResults = [];
const recordG2CorrectionPositive = (id, expected, errors = []) => {
  const uniqueErrors = [...new Set(errors)];
  g2CorrectionPositiveResults.push({ id, pass: uniqueErrors.length === 0, expected, errors: uniqueErrors });
  positiveErrors.push(...uniqueErrors.map((error) => `${id}: ${error}`));
};
const makeWriteSet = (writeSetId, durableIntents) => {
  const candidate = {
    schemaVersion: '1.0',
    orgId: record.orgId,
    writeSetId,
    writeSetDigest: '',
    canonicalMeetingId: record.canonicalMeetingId,
    recordVersion: record.recordVersion,
    recordDigest: record.recordDigest,
    expectedWrites: durableIntents.map((durable) => Object.fromEntries(EXPECTED_INTENT_FIELDS.map((field) => [field, clone(durable[field])]))),
  };
  candidate.writeSetDigest = crmWriteSetDigest(candidate);
  return candidate;
};
const embeddedFields = Object.keys(delivery.crm.writeIntents[0]);
const proposalRequest = clone(crmWriteSetArtifacts.requests[0]);
Object.assign(proposalRequest, {
  clientRequestId: 'briefs:req:opportunity:proposal-domain',
  requestKind: 'user_proposal',
  operation: 'propose_opportunity_change',
  target: { entityType: 'opportunity', entityId: crmProjection.opportunities[0].opportunityId },
  proposedValue: { field: 'stage', value: 'Negotiation', reason: 'Evidence-backed opportunity stage proposal' },
  idempotencyKey: `${record.canonicalMeetingId}:v${record.recordVersion}:crm:opportunity:proposal-domain`,
  submittedBy: { subjectId: 'user:domain-reviewer', sessionId: 'user-session:domain', auditReceiptId: 'audit:crm-proposal:domain', policyVersion: 'crm-request-attribution-v1' },
});
proposalRequest.proposedValueDigest = sha256(jcs(proposalRequest.proposedValue));
proposalRequest.requestDigest = crmIntentRequestDigest(proposalRequest);
const proposalIntent = clone(crmWriteSetArtifacts.intents[0]);
for (const field of Object.keys(proposalRequest)) if (field !== 'schemaVersion') proposalIntent[field] = clone(proposalRequest[field]);
Object.assign(proposalIntent, {
  intentId: 'crm:intent:opportunity:proposal-domain',
  state: 'accepted_pending',
  stateVersion: 1,
  previousIntentDigest: null,
  authoritativeReadbackVersion: null,
  authoritativeReadbackDigest: null,
  reconciliationReceipt: null,
  rejectionCode: null,
});
proposalIntent.intentDigest = crmIntentDigest(proposalIntent);
const proposalWriteSet = makeWriteSet(`${record.canonicalMeetingId}:v${record.recordVersion}:crm-write-set:proposal-domain`, [proposalIntent]);
const proposalDelivery = clone(delivery);
proposalDelivery.crm.writeSetId = proposalWriteSet.writeSetId;
proposalDelivery.crm.writeSetDigest = proposalWriteSet.writeSetDigest;
proposalDelivery.crm.writeIntents = [Object.fromEntries(embeddedFields.map((field) => [field, clone(proposalIntent[field])]))];
proposalDelivery.manifestDigest = deliveryManifestDigest(proposalDelivery);
const { candidateBriefs: proposalBriefs, candidateAck: proposalAck } = bindReadbackToDelivery(proposalDelivery);
recordG2CorrectionPositive('G2-R-P-001', 'propose_opportunity_change closes request, durable, embedded, write-set, and system-join operation domains', [
  ...validateIntentRequest(proposalRequest),
  ...validateIntent(proposalIntent, proposalRequest, record, baseCrmProjection),
  ...validateDelivery(proposalDelivery),
  ...validateSystemJoin({ ...joinedInput, delivery: proposalDelivery, crmWriteSet: proposalWriteSet, crmIntentRequests: [proposalRequest], crmIntents: [proposalIntent], briefsReadback: proposalBriefs, replicationAck: proposalAck }),
]);
const terminalFailedIntent = clone(proposalIntent);
Object.assign(terminalFailedIntent, { state: 'terminal_failed', stateVersion: 2, previousIntentDigest: proposalIntent.intentDigest, rejectionCode: 'CRM_POLICY_TERMINAL', updatedAt: '2026-08-24T04:02:30Z' });
terminalFailedIntent.intentDigest = crmIntentDigest(terminalFailedIntent);
const terminalFailedDelivery = clone(proposalDelivery);
terminalFailedDelivery.crm.writeIntents = [Object.fromEntries(embeddedFields.map((field) => [field, clone(terminalFailedIntent[field])]))];
terminalFailedDelivery.manifestDigest = deliveryManifestDigest(terminalFailedDelivery);
recordG2CorrectionPositive('G2-R-P-002', 'terminal_failed is accepted by the durable and embedded intent domains', [
  ...validateIntent(terminalFailedIntent, proposalRequest, record, baseCrmProjection),
  ...validateDelivery(terminalFailedDelivery),
]);
recordG2CorrectionPositive('G2-R-P-003', 'the governed five-write fixture is exact, complete, and readiness-eligible', [
  ...validateCrmWriteSet(crmWriteSet, record),
  ...validateCrmWriteSetArtifacts(crmWriteSetArtifacts, crmWriteSet, record, baseCrmProjection, crmProjection),
  ...validateSystemJoin(joinedInput),
  ...(deriveSystemState(joinedInput).crmReady && deriveSystemState(joinedInput).normalNotificationEligible ? [] : ['complete CRM write set did not become readiness-eligible']),
]);

const missingWriteSetState = deriveSystemState({ ...joinedInput, crmWriteSet: null });
recordAttack('A-094', 'missing governed CRM write set fails readiness closed', !missingWriteSetState.crmReady && !missingWriteSetState.normalNotificationEligible && missingWriteSetState.joinErrors.includes('CRM expected write set missing'), missingWriteSetState.joinErrors);
const emptyWriteSet = clone(crmWriteSet);
emptyWriteSet.expectedWrites = [];
emptyWriteSet.writeSetDigest = crmWriteSetDigest(emptyWriteSet);
const emptyWriteSetState = deriveSystemState({ ...joinedInput, crmWriteSet: emptyWriteSet });
recordAttack('A-095', 'empty governed CRM write set fails readiness closed', !emptyWriteSetState.crmReady && !emptyWriteSetState.normalNotificationEligible && emptyWriteSetState.joinErrors.includes('CRM expected write set empty'), emptyWriteSetState.joinErrors);
const partialDelivery = clone(delivery);
partialDelivery.crm.writeIntents = partialDelivery.crm.writeIntents.slice(0, -1);
partialDelivery.manifestDigest = deliveryManifestDigest(partialDelivery);
const { candidateBriefs: partialBriefs, candidateAck: partialAck } = bindReadbackToDelivery(partialDelivery);
const partialState = deriveSystemState({ ...joinedInput, delivery: partialDelivery, crmIntentRequests: crmWriteSetArtifacts.requests.slice(0, -1), crmIntents: crmWriteSetArtifacts.intents.slice(0, -1), briefsReadback: partialBriefs, replicationAck: partialAck });
recordAttack('A-096', 'partial request, durable, and embedded sets cannot masquerade as the committed complete set', !partialState.crmReady && !partialState.normalNotificationEligible && partialState.joinErrors.includes('CRM request set mismatch') && partialState.joinErrors.includes('CRM durable intent set mismatch') && partialState.joinErrors.includes('CRM delivery intent set mismatch'), partialState.joinErrors);
const missingRequestState = deriveSystemState({ ...joinedInput, crmIntentRequests: crmWriteSetArtifacts.requests.slice(1) });
recordAttack('A-097', 'a missing request artifact fails bidirectional set equality', !missingRequestState.crmReady && missingRequestState.joinErrors.includes('CRM request set mismatch'), missingRequestState.joinErrors);
const extraRequest = clone(crmWriteSetArtifacts.requests[0]);
extraRequest.clientRequestId = 'briefs:req:attacker:extra';
extraRequest.idempotencyKey = 'attacker:extra:request';
extraRequest.requestDigest = crmIntentRequestDigest(extraRequest);
const extraRequestState = deriveSystemState({ ...joinedInput, crmIntentRequests: [...crmWriteSetArtifacts.requests, extraRequest] });
recordAttack('A-098', 'an extra request artifact fails bidirectional set equality', !extraRequestState.crmReady && extraRequestState.joinErrors.includes('CRM request set mismatch'), extraRequestState.joinErrors);
const duplicateRequestState = deriveSystemState({ ...joinedInput, crmIntentRequests: [...crmWriteSetArtifacts.requests, clone(crmWriteSetArtifacts.requests[0])] });
recordAttack('A-099', 'a duplicate request artifact fails exact-set identity', !duplicateRequestState.crmReady && duplicateRequestState.joinErrors.includes('CRM supplied request set duplicate identity'), duplicateRequestState.joinErrors);
const orphanIntent = clone(crmWriteSetArtifacts.intents[0]);
orphanIntent.intentId = 'crm:intent:attacker:orphan';
orphanIntent.intentDigest = crmIntentDigest(orphanIntent);
const orphanIntentState = deriveSystemState({ ...joinedInput, crmIntents: [...crmWriteSetArtifacts.intents, orphanIntent] });
recordAttack('A-100', 'an orphan durable intent fails bidirectional set equality', !orphanIntentState.crmReady && orphanIntentState.joinErrors.includes('CRM durable intent set mismatch'), orphanIntentState.joinErrors);
const extraEmbeddedDelivery = clone(delivery);
extraEmbeddedDelivery.crm.writeIntents.push(Object.fromEntries(embeddedFields.map((field) => [field, clone(orphanIntent[field])])));
extraEmbeddedDelivery.manifestDigest = deliveryManifestDigest(extraEmbeddedDelivery);
const { candidateBriefs: extraEmbeddedBriefs, candidateAck: extraEmbeddedAck } = bindReadbackToDelivery(extraEmbeddedDelivery);
const extraEmbeddedState = deriveSystemState({ ...joinedInput, delivery: extraEmbeddedDelivery, briefsReadback: extraEmbeddedBriefs, replicationAck: extraEmbeddedAck });
recordAttack('A-101', 'an extra embedded delivery intent fails bidirectional set equality', !extraEmbeddedState.crmReady && extraEmbeddedState.joinErrors.includes('CRM delivery intent set mismatch'), extraEmbeddedState.joinErrors);
const missingDurableState = deriveSystemState({ ...joinedInput, crmIntents: crmWriteSetArtifacts.intents.slice(1) });
recordAttack('A-102', 'a missing durable intent fails bidirectional set equality', !missingDurableState.crmReady && missingDurableState.joinErrors.includes('CRM durable intent set mismatch'), missingDurableState.joinErrors);
const missingEmbeddedDelivery = clone(delivery);
missingEmbeddedDelivery.crm.writeIntents = missingEmbeddedDelivery.crm.writeIntents.slice(1);
missingEmbeddedDelivery.manifestDigest = deliveryManifestDigest(missingEmbeddedDelivery);
const { candidateBriefs: missingEmbeddedBriefs, candidateAck: missingEmbeddedAck } = bindReadbackToDelivery(missingEmbeddedDelivery);
const missingEmbeddedState = deriveSystemState({ ...joinedInput, delivery: missingEmbeddedDelivery, briefsReadback: missingEmbeddedBriefs, replicationAck: missingEmbeddedAck });
recordAttack('A-103', 'a missing embedded delivery intent fails bidirectional set equality', !missingEmbeddedState.crmReady && missingEmbeddedState.joinErrors.includes('CRM delivery intent set mismatch'), missingEmbeddedState.joinErrors);
const duplicateExpectedWriteSet = clone(crmWriteSet);
duplicateExpectedWriteSet.expectedWrites.push(clone(duplicateExpectedWriteSet.expectedWrites[0]));
duplicateExpectedWriteSet.writeSetDigest = crmWriteSetDigest(duplicateExpectedWriteSet);
const duplicateExpectedState = deriveSystemState({ ...joinedInput, crmWriteSet: duplicateExpectedWriteSet });
recordAttack('A-104', 'duplicate expected identities fail the governed write-set contract', !duplicateExpectedState.crmReady && duplicateExpectedState.joinErrors.includes('CRM expected write set duplicate request identity'), duplicateExpectedState.joinErrors);
const supersededDelivery = clone(terminalFailedDelivery);
supersededDelivery.crm.writeIntents[0].state = 'superseded';
supersededDelivery.manifestDigest = deliveryManifestDigest(supersededDelivery);
const supersededErrors = validateDelivery(supersededDelivery);
recordAttack('A-105', 'unsupported superseded state is rejected by the embedded delivery domain', supersededErrors.includes('schema validation failed') && supersededErrors.includes('CRM delivery state domain mismatch'), supersededErrors);

const substitutedPaDelivery = clone(completedDelivery);
substitutedPaDelivery.paDeliveryReceipt.sourceKey = 'attacker:substituted-source';
substitutedPaDelivery.paDeliveryReceipt.readbackDigest = paReadbackDigest(substitutedPaDelivery.paDeliveryReceipt);
substitutedPaDelivery.manifestDigest = deliveryManifestDigest(substitutedPaDelivery);
const substitutedPaBriefs = clone(completedBriefsReadback);
substitutedPaBriefs.manifestDigest = substitutedPaDelivery.manifestDigest;
substitutedPaBriefs.envelopeReadbackDigest = sha256(jcs({ canonicalMeetingId: substitutedPaDelivery.canonicalMeetingId, manifestRevision: substitutedPaDelivery.manifestRevision, manifestDigest: substitutedPaDelivery.manifestDigest }));
substitutedPaBriefs.readbackDigest = digestWithout(substitutedPaBriefs, 'readbackDigest');
const substitutedPaAck = clone(completedAck);
substitutedPaAck.manifestDigest = substitutedPaDelivery.manifestDigest;
substitutedPaAck.readbackDigest = substitutedPaBriefs.readbackDigest;
substitutedPaAck.ackDigest = digestWithout(substitutedPaAck, 'ackDigest');
const substitutedPaState = deriveSystemState({ ...joinedInput, delivery: substitutedPaDelivery, briefsReadback: substitutedPaBriefs, replicationAck: substitutedPaAck });
recordAttack('A-010', 'PA receipt identity is bound to meeting/version/kind', !substitutedPaState.notificationComplete && substitutedPaState.joinErrors.includes('PA receipt identity binding mismatch'), substitutedPaState.joinErrors);
const missingRecordDerived = deriveSystemState({ ...joinedInput, record: null });
const paUnknownDelivery = clone(delivery);
paUnknownDelivery.paDeliveryReceipt = {
  sink: 'pa_telegram', notificationKind: 'normal_completion', sourceKey: 'meeting:demo:v1', outboundDigest: '8080808080808080808080808080808080808080808080808080808080808080', consequentialDeltaDigest: '8181818181818181818181818181818181818181818181818181818181818181', providerMessageId: null, correctsProviderMessageId: null, policyVersion: 'pa-notification-v1', linkKind: 'meeting_record', durablePath: '/business/crm/meetings/meeting_demo_2026_08_24_01', failedSink: null, idempotencyKey: 'meeting:demo:v1:pa', state: 'UNKNOWN_COMMIT', attempt: 1, leaseVersion: 1, previousState: 'LEASED', firstAttemptAt: '2026-08-24T04:01:45Z', deadlineAt: '2026-08-24T04:16:45Z', nextAttemptAt: null, unknownProbeCount: 1, lastProbeAt: '2026-08-24T04:02:00Z', leaseOwner: 'meeting-engine:demo', leaseExpiresAt: '2026-08-24T04:03:00Z', readbackVersion: null, readbackObjectDigest: null, recordDigest: record.recordDigest, readbackDigest: null, updatedAt: '2026-08-24T04:02:00Z', errorCode: null, reconciliationReceipt: null,
};
paUnknownDelivery.manifestDigest = deliveryManifestDigest(paUnknownDelivery);
const paUnknownDerived = deriveSystemState({ ...joinedInput, delivery: paUnknownDelivery, replicationAck: null, briefsReadback: null });
if (!derived.normalNotificationEligible || missingRecordDerived.normalNotificationEligible || paUnknownDerived.normalNotificationEligible || !paUnknownDerived.paReconciliationRequired) positiveErrors.push('derived readiness scenario mismatch');
const result = {
  pass: positiveErrors.length === 0 && negativeResults.every((item) => item.pass) && adversarialResults.every((item) => item.pass),
  positiveErrors,
  negativeResults,
  adversarialResults,
  exactOperationPositiveResults,
  g2CorrectionPositiveResults,
  g3PositiveResults,
  g4PositiveResults,
  g5PositiveResults,
  derived,
  derivedChecks: { completedState, missingRecordDerived, paUnknownDerived },
};
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);

export { authorityRegistryDigest, coverageSnapshotDigest, crmIntentDigest, crmIntentRequestDigest, crmProjectionDigest, crmWriteSetDigest, deliveryManifestDigest, deriveSystemState, dispositionSetDigest, firefliesVerificationConfigDigest, identityOverrideDigest, meetingRecordDeltaDigest, recordDigest, validateAuthorityRegistry, validateBriefsOutput, validateCoverage, validateCoverageClock, validateCrmDomainClosure, validateCrmProjection, validateCrmProjectionTransition, validateCrmWriteSet, validateCrmWriteSetArtifacts, validateDelivery, validateDeliveryTransition, validateDispositionSet, validateFirefliesVectors, validateFirefliesVerificationConfig, validateIdentityOverride, validateIntent, validateIntentRequest, validateIntentTransition, validateObservation, validatePaReceiptBinding, validatePreRecordIngressFailure, validateProcessingFailure, validateRecord, validateRecordTransition, validateReplicationAck, validateReplicationAckBinding, validateSemanticEvaluation, validateSystemJoin, wilsonLowerBound };
