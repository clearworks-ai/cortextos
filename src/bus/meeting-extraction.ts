import { existsSync, readFileSync, openSync, fsyncSync, closeSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import { sha256Canonical } from './meeting-identity.js';

export const DEFAULT_EXTRACTOR_SCRIPT = 'orgs/clearworksai/agents/pa/scripts/ff-extractor.py';

export interface ExtractionRequest {
  evidenceDigest: string;
  evidenceVersion: string;
  extractorVersion: string;
  promptVersion: string;
  promptDigest: string;
  transcriptDigest: string;
  contextDigest: string;
}

export interface ExtractionResponse {
  providerResponse: unknown;
  normalizedOutput: unknown;
}

export interface Extractor {
  extract(request: ExtractionRequest): ExtractionResponse;
}

export interface BoundExtraction {
  evidenceDigest: string;
  evidenceVersion: string;
  extractorVersion: string;
  promptVersion: string;
  requestDigest: string;
  promptDigest: string;
  transcriptDigest: string;
  contextDigest: string;
  providerResponseDigest: string;
  normalizedOutputDigest: string;
  response: ExtractionResponse;
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

function fsyncPath(filePath: string): void {
  const fd = openSync(filePath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function cachePath(storeDir: string, evidenceDigest: string): string {
  return join(storeDir, `${evidenceDigest}.json`);
}

function bind(request: ExtractionRequest, response: ExtractionResponse): BoundExtraction {
  if (!/^[0-9a-f]{64}$/.test(request.evidenceDigest)) {
    throw new ExtractionError('evidenceDigest must be a sha256 hex digest');
  }
  return {
    evidenceDigest: request.evidenceDigest,
    evidenceVersion: request.evidenceVersion,
    extractorVersion: request.extractorVersion,
    promptVersion: request.promptVersion,
    requestDigest: sha256Canonical(request),
    promptDigest: request.promptDigest,
    transcriptDigest: request.transcriptDigest,
    contextDigest: request.contextDigest,
    providerResponseDigest: sha256Canonical(response.providerResponse),
    normalizedOutputDigest: sha256Canonical(response.normalizedOutput),
    response,
  };
}

export function createScriptExtractor(
  scriptPath: string,
  runner: (scriptPath: string, request: ExtractionRequest) => ExtractionResponse,
): Extractor {
  if (scriptPath.length < 1) {
    throw new ExtractionError('extractor script path is required');
  }
  return {
    extract(request) {
      return runner(scriptPath, request);
    },
  };
}

export function extractOnce(
  storeDir: string,
  request: ExtractionRequest,
  extractor: Extractor,
): BoundExtraction {
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => {
    const path = cachePath(storeDir, request.evidenceDigest);
    if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as BoundExtraction;
      if (cached.evidenceDigest !== request.evidenceDigest) {
        throw new ExtractionError('cached extraction evidenceDigest mismatch');
      }
      return cached;
    }
    const bound = bind(request, extractor.extract(request));
    atomicWriteSync(path, JSON.stringify(bound, null, 2));
    fsyncPath(path);
    return bound;
  });
}
