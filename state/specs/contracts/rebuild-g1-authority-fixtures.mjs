#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));
const save = (name, value) => writeFileSync(join(here, name), `${JSON.stringify(value, null, 2)}\n`);
const clone = (value) => JSON.parse(JSON.stringify(value));
const jcs = (value) => Array.isArray(value)
  ? `[${value.map(jcs).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hmacHex = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
const digestWithout = (value, field) => {
  const payload = clone(value);
  delete payload[field];
  return sha256(jcs(payload));
};
const recordDigest = (value) => digestWithout(value, 'recordDigest');
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
const evidenceLineage = (record, claim) => claim.evidenceRefs.map((evidenceId) => {
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
const evidenceLineageDigest = (record, claim) => sha256(jcs(evidenceLineage(record, claim)));
const identityBasisDigest = (record, claim) => sha256(jcs({
  orgId: record.orgId,
  canonicalMeetingId: record.canonicalMeetingId,
  identityPolicyVersion: claim.identityPolicyVersion,
  canonicalClaimId: claim.canonicalClaimId,
  evidenceLineageDigest: evidenceLineageDigest(record, claim),
}));
const candidateSetDigest = (record) => sha256(jcs(record.claims.map((claim) => ({
  claimId: claim.claimId,
  canonicalClaimId: claim.canonicalClaimId,
  identityBasisDigest: claim.identityBasisDigest,
  candidateContentDigest: claim.candidateContentDigest,
  evidenceRefs: [...claim.evidenceRefs].sort(),
})).sort((left, right) => left.claimId.localeCompare(right.claimId))));
const sinkReadbackDigest = (receipt) => sha256(jcs({ sink: receipt.sink, providerId: receipt.providerId, recordDigest: receipt.recordDigest, readbackVersion: receipt.readbackVersion, readbackObjectDigest: receipt.readbackObjectDigest }));

const record = load('meeting-record-v1.golden.json');
const dispositionSet = load('claim-disposition-set-v1.golden.json');
const authorityRoot = load('meeting-authority-root-v1.golden.json');
const authorityPin = load('meeting-authority-root-pin-v1.json');
const request = load('crm-write-intent-request-v1.golden.json');
const pendingIntent = load('crm-write-intent-v1.pending.golden.json');
const intent = load('crm-write-intent-v1.golden.json');
const projection = load('crm-projection-snapshot-v1.golden.json');
const delivery = load('meeting-delivery-envelope-v1.golden.json');
const briefs = load('briefs-projection-readback-v1.golden.json');
const ack = load('projection-replication-ack-v1.golden.json');
const observation = load('meeting-observation-v1.golden.json');
const processingFailure = load('meeting-processing-failure-v1.golden.json');
const preRecordFailure = load('pre-record-ingress-failure-v1.golden.json');
const coverage = load('coverage-snapshot-v1.golden.json');
const coverageEvaluationClock = load('coverage-evaluation-clock-v1.golden.json');
const briefsOutput = load('briefs-meeting-intelligence-output-v1.golden.json');
const semanticEvaluation = load('semantic-evaluation-v1.golden.json');
const relayTestSecrets = load('relay-auth-v1.test-secrets.json');
const firefliesVectors = load('fireflies-webhook-v2-test-vectors.json');

pendingIntent.reconciliationReceipt ??= null;
intent.reconciliationReceipt ??= null;

const firefliesVerificationConfig = {
  schemaVersion: '1.0',
  orgId: observation.orgId,
  provider: 'fireflies',
  configId: 'fireflies:webhook-verification:clearworksai',
  configVersion: 'fireflies-webhook-v2-key-v1',
  configDigest: '',
  validFrom: '2026-01-01T00:00:00Z',
  validUntil: '2027-01-01T00:00:00Z',
  scheme: 'hmac-sha256-raw-body',
  headerName: 'X-Hub-Signature',
  providerDocsSource: 'https://docs.fireflies.ai/graphql-api/webhooks-v2',
  activeKeyId: 'fireflies-webhook-v2-test-key',
  keys: [
    { keyId: 'fireflies-webhook-v2-test-key', status: 'active', validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' },
  ],
  rotation: { policyVersion: 'fireflies-key-rotation-v1', previousKeyId: null, nextKeyId: null, nextRotationAt: '2026-12-01T00:00:00Z', overlapUntil: null },
};
firefliesVerificationConfig.configDigest = digestWithout(firefliesVerificationConfig, 'configDigest');
const firefliesVerificationConfigPin = {
  schemaVersion: '1.0',
  runtimeTrustInput: 'FIREFLIES_VERIFICATION_CONFIG_DIGEST',
  verificationConfigDigest: firefliesVerificationConfig.configDigest,
};
const validFireflies = firefliesVectors.vectors.find((vector) => vector.expected === 'accept');
observation.rawBodyDigest = sha256(validFireflies.rawBodyUtf8);
observation.signatureVerification.scheme = validFireflies.scheme;
observation.signatureVerification.headerName = validFireflies.headerName;
observation.signatureVerification.headerValueDigest = sha256(validFireflies.headerValue);
observation.signatureVerification.keyId = validFireflies.secretKeyId;
observation.signatureVerification.keyConfigVersion = firefliesVerificationConfig.configVersion;
observation.signatureVerification.verificationConfigDigest = firefliesVerificationConfig.configDigest;
observation.signatureVerification.verificationReceiptDigest = sha256(jcs({ provider: observation.provider, providerSourceId: observation.providerSourceId, rawBodyDigest: observation.rawBodyDigest, scheme: observation.signatureVerification.scheme, headerName: observation.signatureVerification.headerName, headerValueDigest: observation.signatureVerification.headerValueDigest, keyId: observation.signatureVerification.keyId, keyConfigVersion: observation.signatureVerification.keyConfigVersion, verificationConfigDigest: observation.signatureVerification.verificationConfigDigest, providerDocsSource: observation.signatureVerification.providerDocsSource, verifiedAt: observation.signatureVerification.verifiedAt, verified: observation.signatureVerification.verified }));
observation.relay.intentDigest = sha256(jcs({ orgId: observation.orgId, observationId: observation.observationId, provider: observation.provider, providerSourceId: observation.providerSourceId, rawBodyDigest: observation.rawBodyDigest }));
observation.relay.durableReceipt = {
  storeId: 'meeting-observation-store-v1',
  storageKey: `${observation.orgId}:${observation.observationId}`,
  observationId: observation.observationId,
  rawBodyDigest: observation.rawBodyDigest,
  persistedAt: '2026-08-24T04:00:01Z',
  durability: 'fsync_committed',
  receiptDigest: '',
};
observation.relay.durableReceipt.receiptDigest = digestWithout(observation.relay.durableReceipt, 'receiptDigest');
delete observation.relay.internalAuthKeyId;
observation.relay.internalAuth = {
  scheme: 'hmac-sha256-canonical-request-v1',
  keyId: 'cortext-relay-key-v1',
  method: 'POST',
  path: '/internal/v1/meeting-observations',
  timestamp: '2026-08-24T04:00:01Z',
  nonce: 'relay_nonce_demo_0001',
  bodyDigest: observation.rawBodyDigest,
  canonicalRequestDigest: null,
  macHex: null,
};
const relayCanonicalPayload = jcs({ method: observation.relay.internalAuth.method, path: observation.relay.internalAuth.path, timestamp: observation.relay.internalAuth.timestamp, nonce: observation.relay.internalAuth.nonce, bodyDigest: observation.relay.internalAuth.bodyDigest, rawBodyDigest: observation.rawBodyDigest, orgId: observation.orgId, observationId: observation.observationId, provider: observation.provider, providerSourceId: observation.providerSourceId, idempotencyKey: observation.relay.idempotencyKey, intentDigest: observation.relay.intentDigest });
observation.relay.internalAuth.canonicalRequestDigest = sha256(relayCanonicalPayload);
const relaySecret = relayTestSecrets.secretsByKeyId[observation.relay.internalAuth.keyId];
observation.relay.internalAuth.macHex = hmacHex(relaySecret, relayCanonicalPayload);
observation.relay.relayReceiptDigest = observation.relay.internalAuth.macHex;
observation.relay.replayReceipt = {
  storeId: 'meeting-relay-nonce-store-v1',
  nonceKey: sha256(jcs({ orgId: observation.orgId, keyId: observation.relay.internalAuth.keyId, nonce: observation.relay.internalAuth.nonce })),
  decision: 'accepted_new',
  acceptedAt: '2026-08-24T04:00:01Z',
  expiresAt: '2026-08-24T04:05:01Z',
  receiptMacHex: null,
};
const replayPayload = jcs({ orgId: observation.orgId, keyId: observation.relay.internalAuth.keyId, nonce: observation.relay.internalAuth.nonce, canonicalRequestDigest: observation.relay.internalAuth.canonicalRequestDigest, storeId: observation.relay.replayReceipt.storeId, nonceKey: observation.relay.replayReceipt.nonceKey, decision: observation.relay.replayReceipt.decision, acceptedAt: observation.relay.replayReceipt.acceptedAt, expiresAt: observation.relay.replayReceipt.expiresAt });
observation.relay.replayReceipt.receiptMacHex = hmacHex(relaySecret, replayPayload);
observation.observationDigest = digestWithout(observation, 'observationDigest');
processingFailure.observationDigest = observation.observationDigest;
processingFailure.failureDigest = digestWithout(processingFailure, 'failureDigest');

preRecordFailure.sourceIdentity.sourceIdentityDigest = digestWithout(preRecordFailure.sourceIdentity, 'sourceIdentityDigest');
preRecordFailure.authenticationState = 'verified';
preRecordFailure.deletionReceipt.deletedAt = preRecordFailure.deletionReceipt.scheduledFor;
preRecordFailure.piiSafeAlertReceipt.receiptDigest = digestWithout(preRecordFailure.piiSafeAlertReceipt, 'receiptDigest');
preRecordFailure.deletionReceipt.quarantineReferenceDigest = sha256(preRecordFailure.encryptedQuarantine.reference);
preRecordFailure.deletionReceipt.receiptDigest = digestWithout(preRecordFailure.deletionReceipt, 'receiptDigest');
preRecordFailure.failureDigest = digestWithout(preRecordFailure, 'failureDigest');

const coverageClockAuthority = {
  schemaVersion: '1.0', orgId: coverage.orgId, policyId: 'coverage-clock:clearworksai', policyDigest: '',
  policyVersion: 'coverage-clock-authority-v1', keyId: 'coverage-clock-test-key-v1',
  validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z', maximumIssuedAtSkewSeconds: 60, replayWindowSeconds: 300,
};
coverageClockAuthority.policyDigest = digestWithout(coverageClockAuthority, 'policyDigest');
const coverageClockAuthorityPin = { schemaVersion: '1.0', runtimeTrustInput: 'COVERAGE_CLOCK_AUTHORITY_DIGEST', authorityPolicyDigest: coverageClockAuthority.policyDigest };
const coverageClockTestSecrets = { schemaVersion: 'coverage-clock-test-secrets-v1', testOnly: true, secretsByKeyId: { 'coverage-clock-test-key-v1': 'coverage-clock-test-secret-v1' } };
Object.assign(coverageEvaluationClock, { issuedAt: '2026-08-24T04:05:59Z', nonce: 'coverage_clock_nonce_0001', authorityPolicyDigest: coverageClockAuthority.policyDigest, authorityKeyId: coverageClockAuthority.keyId });
const clockReceiptPayload = jcs({ orgId: coverageEvaluationClock.orgId, clockId: coverageEvaluationClock.clockId, asOf: coverageEvaluationClock.asOf, issuedAt: coverageEvaluationClock.issuedAt, nonce: coverageEvaluationClock.nonce, policyVersion: coverageEvaluationClock.policyVersion, authorityPolicyDigest: coverageEvaluationClock.authorityPolicyDigest, authorityKeyId: coverageEvaluationClock.authorityKeyId });
coverageEvaluationClock.authorityReceiptMacHex = hmacHex(coverageClockTestSecrets.secretsByKeyId[coverageEvaluationClock.authorityKeyId], clockReceiptPayload);
coverageEvaluationClock.clockDigest = digestWithout(coverageEvaluationClock, 'clockDigest');
coverage.evaluationClockDigest = coverageEvaluationClock.clockDigest;
coverage.freshness.policyVersion = coverageEvaluationClock.policyVersion;
coverage.freshness.evaluatedAsOf = coverageEvaluationClock.asOf;
coverage.freshness.snapshotAgeSeconds = Math.floor((Date.parse(coverageEvaluationClock.asOf) - Date.parse(coverage.generatedAt)) / 1000);
coverage.freshness.sourceLagSeconds = Math.floor((Date.parse(coverageEvaluationClock.asOf) - Date.parse(coverage.cutoffAt)) / 1000);
coverage.freshness.state = coverage.freshness.snapshotAgeSeconds <= coverageEvaluationClock.maxSnapshotAgeSeconds && coverage.freshness.sourceLagSeconds <= coverageEvaluationClock.maxSourceLagSeconds ? 'current' : 'stale';
coverage.freshness.receiptDigest = sha256(jcs({ coverageSnapshotId: coverage.coverageSnapshotId, evaluationClockDigest: coverage.evaluationClockDigest, generatedAt: coverage.generatedAt, cutoffAt: coverage.cutoffAt, policyVersion: coverage.freshness.policyVersion, evaluatedAsOf: coverage.freshness.evaluatedAsOf, state: coverage.freshness.state, snapshotAgeSeconds: coverage.freshness.snapshotAgeSeconds, sourceLagSeconds: coverage.freshness.sourceLagSeconds }));
coverage.snapshotDigest = digestWithout(coverage, 'snapshotDigest');

briefsOutput.coverage = { coverageSnapshotId: coverage.coverageSnapshotId, snapshotDigest: coverage.snapshotDigest, evaluationClockDigest: coverageEvaluationClock.clockDigest, freshnessState: coverage.freshness.state, asOf: coverageEvaluationClock.asOf };
briefsOutput.cSurface.drillThroughMeetingIds = [...coverage.recordIds];
briefsOutput.cSurface.drillThroughDigest = sha256(jcs([...briefsOutput.cSurface.drillThroughMeetingIds].sort()));
briefsOutput.cSurface.denominator = coverage.recordIds.length;
briefsOutput.cSurface.numerator = record.semanticViews.consequentialDeltaClaimIds.length ? 1 : 0;
briefsOutput.cSurface.rate = briefsOutput.cSurface.denominator ? briefsOutput.cSurface.numerator / briefsOutput.cSurface.denominator : 0;
briefsOutput.cSurface.ranking = [{ canonicalMeetingId: record.canonicalMeetingId, movementScore: record.semanticViews.consequentialDeltaClaimIds.length, occurredAt: record.meeting.startedAt }];
const bPath = `/business/crm/meetings/${record.canonicalMeetingId}`;
const cPath = '/business/crm/meetings';
const cToBLink = { canonicalMeetingId: record.canonicalMeetingId, recordDigest: record.recordDigest, fromPath: cPath, toPath: bPath, linkDigest: null };
cToBLink.linkDigest = sha256(jcs({ canonicalMeetingId: cToBLink.canonicalMeetingId, recordDigest: cToBLink.recordDigest, fromPath: cToBLink.fromPath, toPath: cToBLink.toPath }));
briefsOutput.cToBLinks = [cToBLink];
briefsOutput.cSurface.meetingCards = [{ canonicalMeetingId: record.canonicalMeetingId, recordDigest: record.recordDigest, bPath, linkDigest: cToBLink.linkDigest }];
briefsOutput.bSurface.canonicalMeetingId = record.canonicalMeetingId;
briefsOutput.bSurface.recordVersion = record.recordVersion;
briefsOutput.bSurface.recordDigest = record.recordDigest;
briefsOutput.bSurface.title = record.sourceObservations.find((source) => source.state === 'active').title;
const labelClaims = ['fact', 'inference', 'proposal'].map((kind) => record.claims.find((claim) => claim.claimKind === kind));
briefsOutput.bSurface.claimLabels = labelClaims.map((claim) => ({ canonicalClaimId: claim.canonicalClaimId, claimId: claim.claimId, label: claim.claimKind, disposition: claim.disposition.state, semanticClass: claim.semanticClass, evidenceRefs: [...claim.evidenceRefs] }));
const displayedEvidenceIds = [...new Set(labelClaims.flatMap((claim) => claim.evidenceRefs))];
briefsOutput.bSurface.sourceEvidence = displayedEvidenceIds.map((evidenceId) => {
  const evidence = record.evidenceRegistry.find((item) => item.evidenceId === evidenceId);
  const source = record.sourceObservations.find((item) => item.sourceId === evidence.sourceId);
  return { evidenceId, sourceId: evidence.sourceId, artifactId: evidence.artifactId, quoteDigest: evidence.quoteDigest, sourceLineageDigest: source.lineageDigest };
});
briefsOutput.bSurface.freshnessState = coverage.freshness.state;
briefsOutput.bSurface.asOf = coverageEvaluationClock.asOf;
briefsOutput.bSurface.cPath = cPath;
const idsFor = (field) => [...record.semanticViews[field]];
briefsOutput.bSurface.sections = {
  structuredSummary: { headlineClaimId: record.semanticViews.headlineClaimId, narrativeClaimId: record.semanticViews.narrativeClaimId },
  participants: record.participants.map((participant) => ({ participantId: participant.participantId, roleClaimIds: [...participant.roleClaimIds], relationshipClassClaimId: participant.relationshipClassClaimId })),
  topics: { topicClaimIds: idsFor('topicClaimIds'), subtopicClaimIds: idsFor('subtopicClaimIds') },
  decisions: { decisionClaimIds: idsFor('decisionClaimIds'), rationaleClaimIds: idsFor('rationaleClaimIds') },
  discovery: { needClaimIds: idsFor('needClaimIds'), questionClaimIds: idsFor('questionClaimIds'), objectionClaimIds: idsFor('objectionClaimIds'), opportunityClaimIds: idsFor('opportunityClaimIds') },
  changes: { projectChangeClaimIds: idsFor('projectChangeClaimIds'), dealChangeClaimIds: idsFor('dealChangeClaimIds'), accountChangeClaimIds: idsFor('accountChangeClaimIds'), relationshipChangeClaimIds: idsFor('relationshipChangeClaimIds') },
  commitmentsDates: { canonicalClaimIds: record.claims.filter((claim) => claim.semanticClass === 'work_item').map((claim) => claim.canonicalClaimId) },
  lifecycle: clone(record.lifecycle),
  followUpDraft: { state: delivery.followUpDraft.state, draftId: delivery.followUpDraft.draftId, bodyDigest: delivery.followUpDraft.bodyDigest },
  artifactsEvidence: { artifactIds: record.artifacts.map((item) => item.artifactId), evidenceIds: record.evidenceRegistry.map((item) => item.evidenceId) },
  recurringThemes: { claimIds: idsFor('recurringThemeClaimIds') },
  sinkReceiptsFreshness: { sinks: delivery.upstreamReceipts.map((item) => ({ sink: item.sink, state: item.state })), paState: delivery.paDeliveryReceipt?.state ?? null, freshnessState: coverage.freshness.state, asOf: coverageEvaluationClock.asOf },
};
briefsOutput.outputDigest = digestWithout(briefsOutput, 'outputDigest');

const evaluationMeetingIds = Array.from({ length: 16 }, (_, index) => `meeting_eval_${String(index + 1).padStart(2, '0')}`);
semanticEvaluation.meetingSplit.evaluationMeetingIds = evaluationMeetingIds;
semanticEvaluation.meetingSplit.splitDigest = sha256(jcs({ policyVersion: semanticEvaluation.meetingSplit.policyVersion, trainingMeetingIds: [...semanticEvaluation.meetingSplit.trainingMeetingIds].sort(), evaluationMeetingIds: [...evaluationMeetingIds].sort() }));
semanticEvaluation.strata = semanticEvaluation.requiredDimensions.map((dimension) => ({
  dimension,
  stratumId: `stratum:${dimension}:required`,
  positiveMeetingIds: evaluationMeetingIds.slice(0, 8),
  negativeMeetingIds: evaluationMeetingIds.slice(8, 16),
  truePositive: 8,
  falsePositive: 0,
  falseNegative: 0,
  trueNegative: 8,
  precision: 1,
  recall: 1,
  accuracy: 1,
  f1: 1,
  support: 16,
  confidenceLowerBound: 16 / 17,
  status: 'pass',
}));
semanticEvaluation.counterexamples = semanticEvaluation.strata.map((stratum) => ({ counterexampleId: `counterexample:${stratum.dimension}:hard-negative`, stratumId: stratum.stratumId, meetingId: evaluationMeetingIds[8], kind: 'hard_negative', expectedLabel: 'negative', predictedLabel: 'negative', evidenceId: `evidence:${stratum.dimension}:09`, drillThroughPath: `/business/crm/meetings/${evaluationMeetingIds[8]}?evidence=evidence:${stratum.dimension}:09` }));
const semanticDataset = {
  schemaVersion: '1.0', orgId: semanticEvaluation.orgId, datasetId: 'semantic-evaluation-dataset:required-v1', datasetDigest: '',
  policyVersion: 'semantic-truth-prediction-v1', meetingSplitDigest: semanticEvaluation.meetingSplit.splitDigest,
  examples: semanticEvaluation.strata.flatMap((stratum) => evaluationMeetingIds.map((meetingId, index) => ({ exampleId: `example:${stratum.dimension}:${String(index + 1).padStart(2, '0')}`, dimension: stratum.dimension, stratumId: stratum.stratumId, meetingId, truth: index < 8, prediction: index < 8, evidenceId: `evidence:${stratum.dimension}:${String(index + 1).padStart(2, '0')}`, evidenceDigest: sha256(jcs({ dimension: stratum.dimension, meetingId, index })) }))),
};
semanticDataset.datasetDigest = digestWithout(semanticDataset, 'datasetDigest');
semanticEvaluation.datasetDigest = semanticDataset.datasetDigest;
semanticEvaluation.metricReceiptDigest = sha256(jcs({ datasetDigest: semanticDataset.datasetDigest, meetingSplitDigest: semanticEvaluation.meetingSplit.splitDigest, strata: semanticEvaluation.strata.map((item) => ({ stratumId: item.stratumId, truePositive: item.truePositive, falsePositive: item.falsePositive, falseNegative: item.falseNegative, trueNegative: item.trueNegative, precision: item.precision, recall: item.recall, accuracy: item.accuracy, f1: item.f1, support: item.support, confidenceLowerBound: item.confidenceLowerBound, status: item.status })) }));
semanticEvaluation.evaluationDigest = digestWithout(semanticEvaluation, 'evaluationDigest');

for (const claim of record.claims) {
  claim.identityBasisDigest = identityBasisDigest(record, claim);
  claim.candidateContentDigest = sha256(jcs(candidateContentPayload(claim)));
}
record.candidateSetDigest = candidateSetDigest(record);

for (const decision of dispositionSet.dispositions) {
  const claim = record.claims.find((item) => item.claimId === decision.claimId);
  if (!claim) throw new Error(`missing claim ${decision.claimId}`);
  Object.assign(decision, {
    orgId: record.orgId,
    canonicalMeetingId: record.canonicalMeetingId,
    recordVersion: record.recordVersion,
    canonicalClaimId: claim.canonicalClaimId,
    identityBasisDigest: claim.identityBasisDigest,
    evidenceLineageDigest: evidenceLineageDigest(record, claim),
    candidateContentDigest: claim.candidateContentDigest,
    evidenceSetDigest: sha256(jcs([...claim.evidenceRefs].sort())),
  });
  decision.decisionDigest = digestWithout(decision, 'decisionDigest');
  claim.disposition.authority.decisionDigest = decision.decisionDigest;
}
dispositionSet.candidateSetDigest = record.candidateSetDigest;
dispositionSet.dispositionSetDigest = digestWithout(dispositionSet, 'dispositionSetDigest');
record.claimDispositionSetDigest = dispositionSet.dispositionSetDigest;

authorityRoot.authorizedClaimDecisionDigests = dispositionSet.dispositions.map((item) => item.decisionDigest);
authorityRoot.rootDigest = digestWithout(authorityRoot, 'rootDigest');
authorityPin.authorityRootDigest = authorityRoot.rootDigest;
record.recordDigest = recordDigest(record);

for (const artifact of [request, pendingIntent, intent]) {
  artifact.recordDigest = record.recordDigest;
  if ('requestDigest' in artifact) artifact.requestDigest = digestWithout(artifact, 'requestDigest');
  if ('intentDigest' in artifact) artifact.intentDigest = digestWithout(artifact, 'intentDigest');
}
pendingIntent.requestDigest = request.requestDigest;
pendingIntent.intentDigest = digestWithout(pendingIntent, 'intentDigest');
intent.requestDigest = request.requestDigest;
intent.previousIntentDigest = pendingIntent.intentDigest;

for (const row of projection.interactions) {
  row.recordDigest = record.recordDigest;
  row.digest = digestWithout(row, 'digest');
}
for (const row of projection.lifecycleItems) {
  row.recordDigest = record.recordDigest;
  row.digest = digestWithout(row, 'digest');
}
projection.sourceDigest = sha256(jcs({ accounts: projection.accounts, contacts: projection.contacts, engagements: projection.engagements, opportunities: projection.opportunities, interactions: projection.interactions, lifecycleItems: projection.lifecycleItems }));
projection.projectionDigest = digestWithout(projection, 'projectionDigest');
intent.authoritativeReadbackDigest = projection.sourceDigest;
intent.intentDigest = digestWithout(intent, 'intentDigest');

const exactWriteSources = [
  ['upsert_account', 'account', 'accountId', projection.accounts[0]],
  ['upsert_contact', 'contact', 'contactId', projection.contacts[0]],
  ['upsert_engagement', 'engagement', 'engagementId', projection.engagements[0]],
  ['upsert_interaction', 'interaction', 'interactionId', projection.interactions[0]],
  ['upsert_lifecycle', 'lifecycle', 'lifecycleId', projection.lifecycleItems[0]],
];
const writeSetId = `${record.canonicalMeetingId}:v${record.recordVersion}:crm-write-set`;
const requests = [];
const intents = [];
for (const [operation, entityType, idField, sourceRow] of exactWriteSources) {
  const exactRequest = clone(request);
  exactRequest.operation = operation;
  exactRequest.target = { entityType, entityId: sourceRow[idField] };
  const runtimeOnly = new Set(['version', 'digest', 'updatedAt', ...(entityType === 'interaction' ? ['canonicalMeetingId', 'recordDigest'] : [])]);
  exactRequest.proposedValue = Object.fromEntries(Object.entries(sourceRow).filter(([key]) => !runtimeOnly.has(key)));
  exactRequest.proposedValueDigest = sha256(jcs(exactRequest.proposedValue));
  exactRequest.clientRequestId = `briefs:req:${entityType}:write-set`;
  exactRequest.idempotencyKey = `${record.canonicalMeetingId}:v${record.recordVersion}:crm:${entityType}:write-set`;
  exactRequest.requestDigest = digestWithout(exactRequest, 'requestDigest');
  const exactIntent = clone(intent);
  for (const field of Object.keys(exactRequest)) if (field !== 'schemaVersion') exactIntent[field] = clone(exactRequest[field]);
  exactIntent.intentId = `crm:intent:${entityType}:write-set`;
  exactIntent.previousIntentDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  exactIntent.intentDigest = digestWithout(exactIntent, 'intentDigest');
  requests.push(exactRequest);
  intents.push(exactIntent);
}
const writeSet = {
  schemaVersion: '1.0',
  orgId: record.orgId,
  writeSetId,
  writeSetDigest: '',
  canonicalMeetingId: record.canonicalMeetingId,
  recordVersion: record.recordVersion,
  recordDigest: record.recordDigest,
  expectedWrites: intents.map((exactIntent) => Object.fromEntries([
    'clientRequestId', 'requestDigest', 'intentId', 'intentDigest', 'canonicalClaimId', 'claimId', 'requestKind', 'operation', 'target', 'proposedValueDigest', 'evidenceRefs', 'idempotencyKey', 'state',
  ].map((field) => [field, clone(exactIntent[field])]))),
};
writeSet.writeSetDigest = digestWithout(writeSet, 'writeSetDigest');
const writeSetArtifacts = {
  schemaVersion: '1.0',
  orgId: record.orgId,
  writeSetId,
  canonicalMeetingId: record.canonicalMeetingId,
  recordVersion: record.recordVersion,
  recordDigest: record.recordDigest,
  requests,
  intents,
};

delivery.recordDigest = record.recordDigest;
delivery.crm.sourceDigest = projection.sourceDigest;
delivery.crm.projectionDigest = projection.projectionDigest;
delivery.crm.writeSetId = writeSet.writeSetId;
delivery.crm.writeSetDigest = writeSet.writeSetDigest;
const embeddedKeys = Object.keys(delivery.crm.writeIntents[0]);
delivery.crm.writeIntents = intents.map((exactIntent) => Object.fromEntries(embeddedKeys.map((field) => [field, clone(exactIntent[field])])));
for (const receipt of delivery.upstreamReceipts) {
  receipt.reconciliationReceipt ??= null;
  receipt.recordDigest = record.recordDigest;
  if (receipt.sink === 'crm_interaction') {
    receipt.readbackVersion = projection.interactions[0].version;
    receipt.readbackObjectDigest = projection.interactions[0].digest;
  }
  if (receipt.sink === 'lifecycle_projection') receipt.readbackObjectDigest = sha256(jcs(projection.lifecycleItems.map((item) => item.digest).sort()));
  if (receipt.state === 'SUCCEEDED') receipt.readbackDigest = sinkReadbackDigest(receipt);
}
if (delivery.paDeliveryReceipt) delivery.paDeliveryReceipt.reconciliationReceipt ??= null;
const recordReadbackDigest = sha256(jcs({ canonicalMeetingId: record.canonicalMeetingId, recordDigest: record.recordDigest }));
const storedProjectionDigest = sha256(jcs({ orgId: briefs.orgId, canonicalMeetingId: briefs.canonicalMeetingId, recordDigest: record.recordDigest, recordReadbackDigest }));
const briefsReceipt = delivery.upstreamReceipts.find((item) => item.sink === 'briefs_projection');
if (!briefsReceipt) throw new Error('missing Briefs projection receipt');
briefsReceipt.readbackVersion = briefs.storedProjectionVersion;
briefsReceipt.readbackObjectDigest = storedProjectionDigest;
briefsReceipt.readbackDigest = sinkReadbackDigest(briefsReceipt);
delivery.manifestDigest = digestWithout(delivery, 'manifestDigest');

briefs.recordDigest = record.recordDigest;
briefs.manifestDigest = delivery.manifestDigest;
briefs.recordReadbackDigest = recordReadbackDigest;
briefs.envelopeReadbackDigest = sha256(jcs({ canonicalMeetingId: delivery.canonicalMeetingId, manifestRevision: delivery.manifestRevision, manifestDigest: delivery.manifestDigest }));
briefs.storedProjectionDigest = storedProjectionDigest;
briefs.readbackDigest = digestWithout(briefs, 'readbackDigest');

ack.recordDigest = record.recordDigest;
ack.manifestDigest = delivery.manifestDigest;
ack.readbackDigest = briefs.readbackDigest;
ack.storedProjectionDigest = briefs.storedProjectionDigest;
ack.ackDigest = digestWithout(ack, 'ackDigest');

for (const [name, value] of [
  ['meeting-record-v1.golden.json', record],
  ['claim-disposition-set-v1.golden.json', dispositionSet],
  ['meeting-authority-root-v1.golden.json', authorityRoot],
  ['meeting-authority-root-pin-v1.json', authorityPin],
  ['fireflies-verification-config-v1.golden.json', firefliesVerificationConfig],
  ['fireflies-verification-config-pin-v1.json', firefliesVerificationConfigPin],
  ['coverage-clock-authority-v1.golden.json', coverageClockAuthority],
  ['coverage-clock-authority-pin-v1.json', coverageClockAuthorityPin],
  ['coverage-clock-authority-v1.test-secrets.json', coverageClockTestSecrets],
  ['crm-write-intent-request-v1.golden.json', request],
  ['crm-write-intent-v1.pending.golden.json', pendingIntent],
  ['crm-write-intent-v1.golden.json', intent],
  ['crm-write-set-v1.golden.json', writeSet],
  ['crm-write-set-artifacts-v1.golden.json', writeSetArtifacts],
  ['crm-projection-snapshot-v1.golden.json', projection],
  ['meeting-delivery-envelope-v1.golden.json', delivery],
  ['briefs-projection-readback-v1.golden.json', briefs],
  ['projection-replication-ack-v1.golden.json', ack],
  ['meeting-observation-v1.golden.json', observation],
  ['meeting-processing-failure-v1.golden.json', processingFailure],
  ['pre-record-ingress-failure-v1.golden.json', preRecordFailure],
  ['coverage-snapshot-v1.golden.json', coverage],
  ['coverage-evaluation-clock-v1.golden.json', coverageEvaluationClock],
  ['briefs-meeting-intelligence-output-v1.golden.json', briefsOutput],
  ['semantic-evaluation-v1.golden.json', semanticEvaluation],
  ['semantic-evaluation-dataset-v1.golden.json', semanticDataset],
]) save(name, value);

console.log(JSON.stringify({
  authorityRootDigest: authorityRoot.rootDigest,
  dispositionSetDigest: dispositionSet.dispositionSetDigest,
  recordDigest: record.recordDigest,
  decisionCount: dispositionSet.dispositions.length,
}, null, 2));
