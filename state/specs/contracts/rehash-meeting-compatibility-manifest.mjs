#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const manifestPath = join(here, 'meeting-intelligence-compatibility-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

let governedLocalArtifacts = 0;
for (const artifacts of Object.values(manifest.governed_artifacts)) {
  for (const artifact of artifacts) {
    if (artifact.repo !== 'cortextos') continue;
    const path = join(repoRoot, artifact.path);
    const bytes = readFileSync(path);
    artifact.sha256 = createHash('sha256').update(bytes).digest('hex');
    artifact.bytes = bytes.length;
    artifact.mode = (statSync(path).mode & 0o777).toString(8).padStart(4, '0');
    governedLocalArtifacts += 1;
  }
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ governedContracts: manifest.governed_artifacts.contracts.length, governedLocalArtifacts }, null, 2));
