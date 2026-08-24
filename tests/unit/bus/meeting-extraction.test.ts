import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractOnce, createScriptExtractor, DEFAULT_EXTRACTOR_SCRIPT, type Extractor, type ExtractionRequest } from '../../../src/bus/meeting-extraction.js';

function request(evidenceDigest: string): ExtractionRequest {
  return {
    evidenceDigest,
    evidenceVersion: 'evidence-v1',
    extractorVersion: 'extractor-test-v1',
    promptVersion: 'prompt-test-v1',
    promptDigest: '12'.repeat(32),
    transcriptDigest: '13'.repeat(32),
    contextDigest: '14'.repeat(32),
  };
}

describe('meeting extraction', () => {
  it('invokes the extractor once per evidence digest and reuses the bound result on replay', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'meeting-extract-'));
    const calls: ExtractionRequest[] = [];
    const extractor: Extractor = {
      extract(req) {
        calls.push(req);
        return {
          providerResponse: { ok: true, n: calls.length },
          normalizedOutput: { claims: [{ statement: 'pilot chosen' }] },
        };
      },
    };

    try {
      const digest = '17'.repeat(32);
      const first = extractOnce(storeDir, request(digest), extractor);
      const second = extractOnce(storeDir, request(digest), extractor);

      expect(calls).toHaveLength(1);
      expect(first.evidenceDigest).toBe(digest);
      expect(first.requestDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(first.providerResponseDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(first.normalizedOutputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(second).toEqual(first);
      expect(second.response.providerResponse).toEqual({ ok: true, n: 1 });

      extractOnce(storeDir, request('18'.repeat(32)), extractor);
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('invokes ff-extractor.py only through an injectable runner bound to the evidence digest', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'meeting-extract-script-'));
    const spawned: Array<{ scriptPath: string; evidenceDigest: string }> = [];
    const extractor = createScriptExtractor(DEFAULT_EXTRACTOR_SCRIPT, (scriptPath, req) => {
      spawned.push({ scriptPath, evidenceDigest: req.evidenceDigest });
      return {
        providerResponse: { source: 'ff-extractor.py', digest: req.evidenceDigest },
        normalizedOutput: { claims: [] },
      };
    });

    try {
      const digest = '19'.repeat(32);
      extractOnce(storeDir, request(digest), extractor);
      extractOnce(storeDir, request(digest), extractor);
      expect(spawned).toEqual([{ scriptPath: DEFAULT_EXTRACTOR_SCRIPT, evidenceDigest: digest }]);
      expect(spawned[0]?.scriptPath.endsWith('ff-extractor.py')).toBe(true);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
