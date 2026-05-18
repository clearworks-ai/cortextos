import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type VaultModule = typeof import('../../src/lib/vault');

interface FixtureContext {
  frameworkRoot: string;
  sondreVaultRoot: string;
  clearworksVaultRoot: string;
  rawVaultRoot: string;
  outputsVaultRoot: string;
  vault: VaultModule;
}

let fixture: FixtureContext;

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

async function createFixture(): Promise<FixtureContext> {
  const frameworkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-vault-test-'));
  const sondreVaultRoot = path.join(frameworkRoot, 'fixtures', 'sondre-vault');
  const clearworksVaultRoot = path.join(frameworkRoot, 'fixtures', 'clearworks-wiki');
  const rawVaultRoot = path.join(frameworkRoot, 'fixtures', 'clearworks-raw');
  const outputsVaultRoot = path.join(frameworkRoot, 'fixtures', 'clearworks-outputs');

  writeFile(
    path.join(frameworkRoot, 'orgs', 'sondre-hq', 'knowledge.md'),
    [
      `Obsidian vault: \`${sondreVaultRoot}/\``,
      'Vault top-level: 00-inbox,01-projects,02-areas,03-resources,04-archive,05-daily,06-maps',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(frameworkRoot, 'orgs', 'clearworksai', 'knowledge.md'),
    [
      `Obsidian vault: \`${clearworksVaultRoot}/\``,
      `Raw vault: \`${rawVaultRoot}/\``,
      `Outputs vault: \`${outputsVaultRoot}/\``,
      '',
    ].join('\n'),
  );

  writeFile(path.join(sondreVaultRoot, '00-inbox', 'inbox.md'), '# inbox\n');
  writeFile(path.join(sondreVaultRoot, '01-projects', 'project.md'), '# project\n');
  writeFile(path.join(sondreVaultRoot, '07-loose', 'skip.md'), '# skip\n');

  writeFile(path.join(clearworksVaultRoot, 'agents', 'agent.md'), '# agent\n');
  writeFile(path.join(clearworksVaultRoot, 'projects', 'project.md'), '# project\n');
  writeFile(path.join(clearworksVaultRoot, 'tools', 'tool.md'), '# tool\n');
  writeFile(path.join(clearworksVaultRoot, 'node_modules', 'skip.md'), '# skip\n');
  writeFile(path.join(clearworksVaultRoot, 'graphify-out', 'skip.md'), '# skip\n');
  writeFile(path.join(clearworksVaultRoot, 'cc', 'skip.md'), '# skip\n');
  writeFile(path.join(clearworksVaultRoot, '.obsidian', 'skip.md'), '# skip\n');

  writeFile(path.join(rawVaultRoot, 'INTEGRATION.md'), '# integration\n');
  writeFile(path.join(outputsVaultRoot, 'some-file.md'), '# output\n');

  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  vi.resetModules();
  const vault = await import('../../src/lib/vault');

  return {
    frameworkRoot,
    sondreVaultRoot,
    clearworksVaultRoot,
    rawVaultRoot,
    outputsVaultRoot,
    vault,
  };
}

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(() => {
  if (fixture) {
    fs.rmSync(fixture.frameworkRoot, { recursive: true, force: true });
  }
  delete process.env.CTX_FRAMEWORK_ROOT;
  vi.resetModules();
});

describe('vault helpers', () => {
  it('T1: returns sondre-hq top-level allow-list', () => {
    expect(fixture.vault.getVaultTopLevelAllowList('sondre-hq')).toEqual([
      '00-inbox',
      '01-projects',
      '02-areas',
      '03-resources',
      '04-archive',
      '05-daily',
      '06-maps',
    ]);
  });

  it('T2: returns null allow-list when no line is configured', () => {
    expect(fixture.vault.getVaultTopLevelAllowList('clearworksai')).toBeNull();
  });

  it('T3: resolveVaultPath accepts a non-PARA top-level dir', () => {
    const resolved = fixture.vault.resolveVaultPath(
      fixture.clearworksVaultRoot,
      'agents/agent.md',
    );
    expect(resolved).toBe(path.join(fixture.clearworksVaultRoot, 'agents', 'agent.md'));
  });

  it('T4: resolveVaultPath still rejects traversal', () => {
    expect(
      fixture.vault.resolveVaultPath(fixture.clearworksVaultRoot, '../etc/passwd'),
    ).toBeNull();
  });

  it('T5: listAllNotes(org-aware) respects the sondre-hq allow-list', () => {
    const notes = fixture.vault
      .listAllNotes(fixture.sondreVaultRoot, 'sondre-hq')
      .map((note) => note.relPath)
      .sort();

    expect(notes).toEqual(['00-inbox/inbox.md', '01-projects/project.md']);
  });

  it('T6: listAllNotes(org-aware) walks all non-dot, non-junk top-level dirs when no allow-list exists', () => {
    const notes = fixture.vault
      .listAllNotes(fixture.clearworksVaultRoot, 'clearworksai')
      .map((note) => note.relPath)
      .sort();

    expect(notes).toEqual([
      'agents/agent.md',
      'projects/project.md',
      'tools/tool.md',
    ]);
  });

  it('T7: returns the configured raw vault root', () => {
    expect(fixture.vault.getRawVaultRoot('clearworksai')).toBe(fixture.rawVaultRoot);
  });

  it('T8: returns the configured outputs vault root', () => {
    expect(fixture.vault.getOutputsVaultRoot('clearworksai')).toBe(
      fixture.outputsVaultRoot,
    );
  });

  it('T9: resolveRawVaultPath rejects escapes and accepts contained relative paths', () => {
    expect(
      fixture.vault.resolveRawVaultPath(fixture.rawVaultRoot, '../etc/passwd'),
    ).toBeNull();
    expect(
      fixture.vault.resolveRawVaultPath(fixture.rawVaultRoot, '/abs/path/outside'),
    ).toBeNull();

    const resolved = fixture.vault.resolveRawVaultPath(
      fixture.rawVaultRoot,
      'INTEGRATION.md',
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.startsWith(fixture.rawVaultRoot + path.sep)).toBe(true);
  });

  it('T10: resolveOutputsVaultPath rejects escapes and accepts contained relative paths', () => {
    expect(
      fixture.vault.resolveOutputsVaultPath(fixture.outputsVaultRoot, '../etc/passwd'),
    ).toBeNull();
    expect(
      fixture.vault.resolveOutputsVaultPath(
        fixture.outputsVaultRoot,
        '/abs/path/outside',
      ),
    ).toBeNull();

    const resolved = fixture.vault.resolveOutputsVaultPath(
      fixture.outputsVaultRoot,
      'some-file.md',
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.startsWith(fixture.outputsVaultRoot + path.sep)).toBe(true);
  });
});
