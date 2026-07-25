import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { hasNodeSqlite, openLinksDb, edgeStats } from '../../../../src/bus/kb-graph/db.js';
import {
  dreamScan,
  recordVerdict,
  validateDreamPayload,
  fileDreamPayload,
  dreamStatus,
} from '../../../../src/bus/kb-graph/dream.js';
import { writeHeartbeat } from '../../../../src/bus/reliable-job.js';
import { createSlugResolver } from '../../../../src/bus/kb-graph/resolve.js';

describe.skipIf(!hasNodeSqlite())('kb-graph/dream', () => {
  let dir: string;
  let dbPath: string;
  let corpus: string;
  let ksRoot: string;
  let jobsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dream-'));
    dbPath = join(dir, 'links.sqlite');
    corpus = join(dir, 'state');
    mkdirSync(join(corpus, 'agent-a'), { recursive: true });
    ksRoot = join(dir, 'knowledge-sync');
    mkdirSync(join(ksRoot, 'wiki', 'people'), { recursive: true });
    mkdirSync(join(ksRoot, 'wiki', 'intelligence'), { recursive: true });
    writeFileSync(join(ksRoot, 'wiki', 'people', 'josh-weiss.md'), '# Josh Weiss\n');
    jobsDir = join(dir, 'jobs');
    mkdirSync(jobsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBuffer(name: string, body: string): string {
    const p = join(corpus, 'agent-a', name);
    writeFileSync(p, body);
    return p;
  }

  it('scan pending + alreadyDone + hash change', () => {
    writeBuffer('conversation-buffer.jsonl', '{"msg":1}\n');
    writeBuffer('other-transcript.jsonl', '{"msg":2}\n');
    const s1 = dreamScan({ roots: [corpus], dbPath });
    expect(s1.pending.length).toBe(2);

    // mark filed
    const db = openLinksDb(dbPath);
    for (const j of s1.pending) {
      db.prepare(`UPDATE dream_jobs SET status='filed' WHERE job_key=?`).run(j.jobKey);
    }
    db.close();
    const s2 = dreamScan({ roots: [corpus], dbPath });
    expect(s2.pending.length).toBe(0);
    expect(s2.alreadyDone).toBe(2);

    writeBuffer('conversation-buffer.jsonl', '{"msg":1,"changed":true}\n');
    const s3 = dreamScan({ roots: [corpus], dbPath });
    expect(s3.pending.length).toBe(1);
  });

  it('verdict no rejects; cached idempotent', () => {
    const p = writeBuffer('conversation-buffer.jsonl', 'x\n');
    const s = dreamScan({ roots: [corpus], dbPath });
    const key = s.pending[0].jobKey;
    const db = openLinksDb(dbPath);
    recordVerdict(db, key, 'no', 'haiku');
    recordVerdict(db, key, 'yes', 'should-not-overwrite');
    const v = db.prepare('SELECT verdict FROM dream_verdicts WHERE job_key=?').get(key) as {
      verdict: string;
    };
    expect(v.verdict).toBe('no');
    const job = db.prepare('SELECT status FROM dream_jobs WHERE job_key=?').get(key) as {
      status: string;
    };
    expect(job.status).toBe('rejected');
    db.close();
    const s2 = dreamScan({ roots: [corpus], dbPath });
    expect(s2.rejected).toBe(1);
    expect(s2.pending.find((j) => j.jobKey === key)).toBeUndefined();
    void p;
  });

  it('validateDreamPayload', () => {
    expect(validateDreamPayload({}).ok).toBe(false);
    expect(
      validateDreamPayload({
        entities: [{ name: 'Josh' }],
        edges: [{ from: 'Josh', to: 'Clearworks', type: 'works_at' }],
        pages: [{ slug_hint: 'people/josh', title: 'J', markdown: '# J' }],
      }).ok,
    ).toBe(true);
    const bad = validateDreamPayload({
      entities: [{}],
      edges: [{ from: 'a', to: 'b', type: 'explode' }],
      pages: [{ slug_hint: 'x' }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('fileDreamPayload dual-write + collision + idempotent', () => {
    const p = writeBuffer('conversation-buffer.jsonl', 'session\n');
    const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
    const jobKey = `dream:synth:${p}:${hash}`;
    const db = openLinksDb(dbPath);
    db.prepare(
      `INSERT INTO dream_jobs (job_key, path, content_hash, status, entities_filed, edges_filed, pages_written, error, updated_at)
       VALUES (?, ?, ?, 'approved', 0, 0, 0, NULL, ?)`,
    ).run(jobKey, p, hash, new Date().toISOString());

    const resolver = createSlugResolver(join(ksRoot, 'wiki'));
    const payload = {
      entities: [
        { name: 'Josh', type: 'people' },
        { name: 'Clearworks', type: 'companies' },
      ],
      edges: [{ from: 'Josh', to: 'Clearworks', type: 'works_at', context: 'works there' }],
      pages: [
        {
          slug_hint: 'people/new-hire',
          title: 'New Hire',
          markdown: '# New Hire\n\nFrom dream.\n',
        },
      ],
    };

    // seed companies dir as allowed by creating it
    mkdirSync(join(ksRoot, 'wiki', 'companies'), { recursive: true });

    const r1 = fileDreamPayload(db, jobKey, payload, resolver, ksRoot);
    expect(r1.edgesFiled).toBe(1);
    expect(r1.pagesWritten.length).toBe(1);
    expect(existsSync(join(ksRoot, 'wiki', 'people', 'new-hire.md'))).toBe(true);
    expect(existsSync(join(ksRoot, 'wiki', 'intelligence', 'dream-index.md'))).toBe(true);
    const stats = edgeStats(db);
    expect(stats.edges).toBeGreaterThanOrEqual(1);
    const edge = db
      .prepare(`SELECT confidence, link_kind FROM edges WHERE type='works_at'`)
      .get() as { confidence: number; link_kind: string };
    expect(edge.confidence).toBe(0.9);
    expect(edge.link_kind).toBe('typed_ner');

    // collision
    writeFileSync(join(ksRoot, 'wiki', 'people', 'exists.md'), '# original\n');
    const jobKey2 = jobKey + '-2';
    db.prepare(
      `INSERT INTO dream_jobs (job_key, path, content_hash, status, entities_filed, edges_filed, pages_written, error, updated_at)
       VALUES (?, ?, ?, 'approved', 0, 0, 0, NULL, ?)`,
    ).run(jobKey2, p, hash, new Date().toISOString());
    const r2 = fileDreamPayload(
      db,
      jobKey2,
      {
        entities: [],
        edges: [],
        pages: [{ slug_hint: 'people/exists', title: 'E', markdown: '# different\n' }],
      },
      resolver,
      ksRoot,
    );
    expect(readFileSync(join(ksRoot, 'wiki', 'people', 'exists.md'), 'utf-8')).toContain('original');
    expect(r2.pagesWritten.some((wp) => wp.includes('exists-'))).toBe(true);

    // idempotent re-file same payload
    const before = edgeStats(db).edges;
    // reset status so file can run — actually file always runs upserts
    fileDreamPayload(db, jobKey, payload, resolver, ksRoot);
    expect(edgeStats(db).edges).toBe(before);
    db.close();
  });

  it('allowed-slug guard rejects escape and unknown top dir', () => {
    const db = openLinksDb(dbPath);
    const resolver = createSlugResolver(join(ksRoot, 'wiki'));
    const jobKey = 'dream:synth:/tmp/x:abc';
    db.prepare(
      `INSERT INTO dream_jobs (job_key, path, content_hash, status, entities_filed, edges_filed, pages_written, error, updated_at)
       VALUES (?, '/tmp/x', 'abc', 'approved', 0, 0, 0, NULL, ?)`,
    ).run(jobKey, new Date().toISOString());

    expect(() =>
      fileDreamPayload(
        db,
        jobKey,
        {
          entities: [],
          edges: [],
          pages: [{ slug_hint: 'evil/../../escape', title: 'x', markdown: 'y' }],
        },
        resolver,
        ksRoot,
      ),
    ).toThrow(/reject|escape|allowed/i);

    expect(() =>
      fileDreamPayload(
        db,
        jobKey + '2',
        {
          entities: [],
          edges: [],
          pages: [{ slug_hint: 'unknownns/foo', title: 'x', markdown: 'y' }],
        },
        resolver,
        ksRoot,
      ),
    ).toThrow(/allowed/);
    db.close();
  });

  it('status check neverSucceeded then passes after heartbeat', () => {
    const db = openLinksDb(dbPath);
    let status = dreamStatus(db, jobsDir);
    expect(status.neverSucceeded).toBe(true);

    writeHeartbeat(jobsDir, 'gbrain-dream', { success: true, intervalMs: 86_400_000 });
    status = dreamStatus(db, jobsDir);
    expect(status.neverSucceeded).toBe(false);
    expect(status.lastCompletionTs).toBeTruthy();
    db.close();
  });
});
