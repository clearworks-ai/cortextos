#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractsRoot = path.join(repositoryRoot, 'state/specs/contracts');
const consumerArgument = process.argv[2];
if (!consumerArgument) throw new Error('usage: verify-meeting-intelligence-cross-repo.mjs <briefs-root>');

const consumerRoot = realpathSync(consumerArgument);
const vendorRoot = realpathSync(path.join(consumerRoot, 'contracts/meeting-intelligence/v1'));
if (!vendorRoot.startsWith(`${consumerRoot}${path.sep}`)) {
  throw new Error('Briefs vendor root escapes consumer repository');
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const verifyArtifact = (sourceFile, targetFile, artifact) => {
  const sourceReal = realpathSync(sourceFile);
  const targetReal = realpathSync(targetFile);
  const sourceSha = sha256(sourceReal);
  const targetSha = sha256(targetReal);
  if (sourceSha !== artifact.sha256 || targetSha !== artifact.sha256 || sourceSha !== targetSha) {
    throw new Error(`${path.basename(sourceFile)}: SHA-256 equality failed`);
  }
  if (statSync(sourceReal).size !== artifact.bytes || statSync(targetReal).size !== artifact.bytes) {
    throw new Error(`${path.basename(sourceFile)}: byte-count equality failed`);
  }
  const expectedMode = Number.parseInt(artifact.mode, 8);
  if ((statSync(sourceReal).mode & 0o777) !== expectedMode
      || (statSync(targetReal).mode & 0o777) !== expectedMode) {
    throw new Error(`${path.basename(sourceFile)}: filesystem-mode equality failed`);
  }
};

const manifestName = 'meeting-intelligence-compatibility-manifest.json';
const manifest = JSON.parse(readFileSync(path.join(contractsRoot, manifestName), 'utf8'));
const contracts = [
  ...manifest.governed_artifacts.contracts,
  {
    path: `state/specs/contracts/${manifestName}`,
    sha256: 'd31613b239bca37e34ee01d14dba780bfe2f1dd89f3fea451e0d2a783dbee530',
    bytes: 37893,
    mode: '0400',
  },
];
for (const artifact of contracts) {
  const leaf = path.basename(artifact.path);
  verifyArtifact(path.join(contractsRoot, leaf), path.join(vendorRoot, leaf), artifact);
}

const productArtifacts = [...manifest.governed_artifacts.specs, ...manifest.governed_artifacts.product]
  .filter((artifact) => artifact.target_repository === 'briefs');
for (const artifact of productArtifacts) {
  const targetFile = realpathSync(path.join(consumerRoot, artifact.target_path));
  if (!targetFile.startsWith(`${consumerRoot}${path.sep}`)) {
    throw new Error(`${artifact.target_path}: consumer containment check failed`);
  }
  if (sha256(targetFile) !== artifact.sha256 || statSync(targetFile).size !== artifact.bytes) {
    throw new Error(`${artifact.target_path}: governed product equality failed`);
  }
  if ((statSync(targetFile).mode & 0o777) !== Number.parseInt(artifact.mode, 8)) {
    throw new Error(`${artifact.target_path}: governed product mode failed`);
  }
}

if (manifest.promotion_authority !== false) throw new Error('promotion_authority must remain false');
console.log(JSON.stringify({
  pass: true,
  direction: 'cortextos-to-briefs',
  contractsEqual: contracts.length,
  productArtifactsEqual: productArtifacts.length,
  promotionAuthority: manifest.promotion_authority,
}));
