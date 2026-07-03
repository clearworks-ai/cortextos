import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateOutboundTelegram, loadOverrides } from '../../../src/utils/send-telegram-validator';
import { writeVerifyReceipt, type VerifyReceipt } from '../../../src/utils/verify-receipts';

let ctxRoot: string;
const AGENT = 'larry';

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'send-telegram-validator-'));
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function receipt(overrides: Partial<VerifyReceipt> = {}): VerifyReceipt {
  return {
    kind: 'generic',
    target: 'the fix',
    command: 'npm test',
    output: 'ok',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function writeOverlay(content: string): void {
  mkdirSync(join(ctxRoot, 'state'), { recursive: true });
  writeFileSync(join(ctxRoot, 'state', 'send-telegram-overrides.json'), content, 'utf-8');
}

describe('Gate A — claim-gate', () => {
  const CLAIMS = [
    "The dashboard is live now, check it out",
    "it's fixed on prod",
    "I've deployed the new validator",
    "fix is in, go ahead",
    "deployed and verified end to end",
    "confirmed working after restart",
  ];

  for (const claim of CLAIMS) {
    it(`throws without a receipt: "${claim}"`, () => {
      expect(() => validateOutboundTelegram(ctxRoot, AGENT, claim)).toThrowError(/claim-gate/);
    });
  }

  it('rejection names the exact remediation command', () => {
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'The fix is live')).toThrowError(
      /cortextos bus verify-receipt --kind url --target <url> --command "curl -s -o \/dev\/null -w %\{http_code\} <url>"/
    );
  });

  it('passes with a fresh (<15min) receipt', () => {
    writeVerifyReceipt(ctxRoot, AGENT, receipt());
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'The fix is live')).not.toThrow();
  });

  it('throws with only a 16-minute-old receipt', () => {
    writeVerifyReceipt(
      ctxRoot,
      AGENT,
      receipt({ created_at: new Date(Date.now() - 16 * 60_000).toISOString() })
    );
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'The fix is live')).toThrowError(/claim-gate/);
  });

  it("bare 'done'/'fixed' do NOT trigger the gate — 'task done per your request' passes", () => {
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'task done per your request')).not.toThrow();
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'Closed the ticket, fixed formatting in the doc')).not.toThrow();
  });

  it("another agent's receipt does not ground larry's claim", () => {
    writeVerifyReceipt(ctxRoot, 'frank2', receipt());
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'The fix is live')).toThrowError(/claim-gate/);
  });
});

describe('Gate B — never-send-task-list', () => {
  it('throws on a 10-line bullet dump', () => {
    const dump = Array.from({ length: 10 }, (_, i) => `- task item ${i + 1}`).join('\n');
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, dump)).toThrowError(/never-send-task-list/);
  });

  it('throws on a numbered 8-item list', () => {
    const dump = Array.from({ length: 8 }, (_, i) => `${i + 1}. task item`).join('\n');
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, dump)).toThrowError(/never-send-task-list/);
  });

  it('allows a short 3-bullet summary', () => {
    const short = '- shipped the gate\n- tests green\n- next: WS3';
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, short)).not.toThrow();
  });

  it('throws on 3+ [HUMAN] tags even with few lines', () => {
    const msg = '[HUMAN] pay invoice, [HUMAN] sign contract, [HUMAN] call Marcos';
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, msg)).toThrowError(/never-send-task-list/);
  });

  it('rejection cites the source feedback and a remediation', () => {
    const dump = Array.from({ length: 10 }, (_, i) => `- item ${i}`).join('\n');
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, dump)).toThrowError(
      /feedback_no_auto_human_task_list_sends[\s\S]*Remediation/
    );
  });
});

describe('Gate C — URL allowlist', () => {
  it('rejects a non-allowlisted URL outright', () => {
    expect(() =>
      validateOutboundTelegram(ctxRoot, AGENT, 'see https://example.com/report')
    ).toThrowError(/url-allowlist/);
  });

  it('rejection names the host and the overlay remediation', () => {
    expect(() =>
      validateOutboundTelegram(ctxRoot, AGENT, 'see https://example.com/report')
    ).toThrowError(/example\.com[\s\S]*allowedUrlHosts[\s\S]*send-telegram-overrides\.json/);
  });

  it('rejects a briefs URL without a fresh url receipt, with the exact curl remediation', () => {
    const url = 'https://briefs.clearworks.ai/0buqShwfHueh';
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, `Brief: ${url}`)).toThrowError(
      new RegExp(
        `cortextos bus verify-receipt --kind url --target ${url} --command "curl -s -o /dev/null -w %\\{http_code\\} ${url}"`
      )
    );
  });

  it('passes a briefs URL with a fresh kind:url receipt for that exact URL', () => {
    const url = 'https://briefs.clearworks.ai/0buqShwfHueh';
    writeVerifyReceipt(ctxRoot, AGENT, receipt({ kind: 'url', target: url, command: `curl ${url}`, output: '200' }));
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, `Brief: ${url}`)).not.toThrow();
  });

  it('a url receipt for a DIFFERENT briefs URL does not count', () => {
    writeVerifyReceipt(
      ctxRoot,
      AGENT,
      receipt({ kind: 'url', target: 'https://briefs.clearworks.ai/other', output: '200' })
    );
    expect(() =>
      validateOutboundTelegram(ctxRoot, AGENT, 'Brief: https://briefs.clearworks.ai/0buqShwfHueh')
    ).toThrowError(/url-allowlist/);
  });

  it('a stale (16min) url receipt does not count', () => {
    const url = 'https://briefs.clearworks.ai/0buqShwfHueh';
    writeVerifyReceipt(
      ctxRoot,
      AGENT,
      receipt({ kind: 'url', target: url, created_at: new Date(Date.now() - 16 * 60_000).toISOString() })
    );
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, `Brief: ${url}`)).toThrowError(/url-allowlist/);
  });

  it('telegram.org and t.me pass without receipts', () => {
    expect(() =>
      validateOutboundTelegram(ctxRoot, AGENT, 'docs: https://core.telegram.org/bots and https://t.me/somebot')
    ).not.toThrow();
  });

  it('overlay allowedUrlHosts pass', () => {
    writeOverlay(JSON.stringify({ allowedUrlHosts: ['clearworks.ai'] }));
    expect(() =>
      validateOutboundTelegram(ctxRoot, AGENT, 'site: https://www.clearworks.ai/pricing')
    ).not.toThrow();
  });
});

describe('Gate D — stop-means-stop (per-agent)', () => {
  it('blocks EVERY send for the flagged agent, including harmless text', () => {
    mkdirSync(join(ctxRoot, 'state', AGENT), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', AGENT, 'stop.flag'), '', 'utf-8');

    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'good morning')).toThrowError(
      /stop-means-stop[\s\S]*Josh set a stop flag; do not message until he initiates/
    );
    // Even a fully-receipted claim is blocked.
    writeVerifyReceipt(ctxRoot, AGENT, receipt());
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'The fix is live')).toThrowError(/stop-means-stop/);
  });

  it('is per-agent: another agent without the flag is unaffected', () => {
    mkdirSync(join(ctxRoot, 'state', AGENT), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', AGENT, 'stop.flag'), '', 'utf-8');

    expect(() => validateOutboundTelegram(ctxRoot, 'frank2', 'good morning')).not.toThrow();
  });
});

describe('overlay merge + malformed overlay fallback', () => {
  it('extraClaimPatterns are enforced like base claim patterns', () => {
    writeOverlay(JSON.stringify({ extraClaimPatterns: ['\\ball systems nominal\\b'] }));
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'All systems nominal!')).toThrowError(/claim-gate/);

    writeVerifyReceipt(ctxRoot, AGENT, receipt());
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'All systems nominal!')).not.toThrow();
  });

  it('malformed overlay warns to stderr and falls back to base rules', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeOverlay('not json{{{');

    // Base rules still enforced...
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'The fix is live')).toThrowError(/claim-gate/);
    // ...and normal messages still pass (the malformed overlay never blocks by itself).
    expect(() => validateOutboundTelegram(ctxRoot, AGENT, 'good morning')).not.toThrow();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('malformed overlay'));
  });

  it('invalid regex entries are skipped, valid ones kept', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeOverlay(JSON.stringify({ extraClaimPatterns: ['[invalid(', '\\bnominal\\b'], allowedUrlHosts: [42, 'ok.example'] }));

    const overrides = loadOverrides(ctxRoot);
    expect(overrides.extraClaimPatterns).toHaveLength(1);
    expect(overrides.allowedUrlHosts).toEqual(['ok.example']);
    expect(stderrSpy).toHaveBeenCalled();
  });
});

describe('fail-closed semantics', () => {
  it('throws instead of returning a stripped message (return type is void, message untouched)', () => {
    const msg = 'The fix is live https://example.com';
    let threw = false;
    try {
      validateOutboundTelegram(ctxRoot, AGENT, msg);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/BLOCKED/);
    }
    expect(threw).toBe(true);
  });
});
