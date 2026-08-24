#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractsRoot = path.join(repositoryRoot, 'state/specs/contracts');
const draft202012 = 'https://json-schema.org/draft/2020-12/schema';

const readJson = (name) => JSON.parse(readFileSync(path.join(contractsRoot, name), 'utf8'));
const schemaFiles = readdirSync(contractsRoot).filter((name) => name.endsWith('.schema.json')).sort();
const goldenFiles = readdirSync(contractsRoot).filter((name) => name.endsWith('.golden.json')).sort();

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

for (const name of schemaFiles) {
  const schema = readJson(name);
  if (schema.$schema !== draft202012) {
    throw new Error(`${name}: expected Draft 2020-12, received ${schema.$schema ?? 'none'}`);
  }
  ajv.addSchema(schema);
}

for (const name of goldenFiles) {
  const schemaName = name.replace(/(?:\.base|\.pending)?\.golden\.json$/, '.schema.json');
  const schema = readJson(schemaName);
  const validate = ajv.getSchema(schema.$id);
  if (!validate || !validate(readJson(name))) {
    throw new Error(`${name}: ${ajv.errorsText(validate?.errors, { separator: '; ' })}`);
  }
}

const semanticResult = JSON.parse(execFileSync(
  process.execPath,
  [path.join(contractsRoot, 'validate-meeting-contracts.mjs')],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEETING_AUTHORITY_ROOT_DIGEST: readJson('meeting-authority-root-pin-v1.json').authorityRootDigest,
      FIREFLIES_VERIFICATION_CONFIG_DIGEST: readJson('fireflies-verification-config-pin-v1.json').verificationConfigDigest,
      COVERAGE_CLOCK_AUTHORITY_DIGEST: readJson('coverage-clock-authority-pin-v1.json').authorityPolicyDigest,
    },
  },
));
if (!semanticResult.pass) throw new Error('governed semantic contract validation failed');

const compatibility = readJson('meeting-intelligence-compatibility-manifest.json');
if (compatibility.promotion_authority !== false) throw new Error('promotion_authority must remain false');
if (compatibility.compatibility?.n_minus_1_required !== true) {
  throw new Error('N-1 compatibility is not required by the authority manifest');
}
if (compatibility.compatibility?.reader_support?.includes('meeting-intelligence-v1') !== true
    || compatibility.compatibility?.producer_emit !== 'meeting-intelligence-v1') {
  throw new Error('N reader/producer contract does not bind meeting-intelligence-v1');
}
if (compatibility.predecessor_local_candidate?.schema_version !== 'meeting-intelligence-compatibility-manifest-v11') {
  throw new Error('N-1 compatibility-manifest predecessor is not pinned');
}

console.log(JSON.stringify({
  pass: true,
  draft: '2020-12',
  schemasCompiled: schemaFiles.length,
  goldenFixturesValidated: goldenFiles.length,
  negativeCasesRejected: semanticResult.negativeResults.filter((item) => item.pass).length,
  readerVersion: compatibility.compatibility.reader_support[0],
  producerVersion: compatibility.compatibility.producer_emit,
  nMinus1: true,
  promotionAuthority: compatibility.promotion_authority,
}));
