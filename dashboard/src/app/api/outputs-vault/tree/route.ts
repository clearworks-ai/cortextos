import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { getOutputsVaultRoot } from '@/lib/vault';

export const dynamic = 'force-dynamic';

const SKIP = new Set(['node_modules', 'graphify-out', 'cc']);

type TreeNode =
  | {
      kind: 'dir';
      name: string;
      relPath: string;
      children: TreeNode[];
    }
  | {
      kind: 'file';
      name: string;
      relPath: string;
      mtimeMs: number;
    };

const ORG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const org = url.searchParams.get('org');

  if (!org || !ORG_RE.test(org)) {
    return Response.json({ error: 'Invalid org parameter' }, { status: 400 });
  }

  const outputsRoot = getOutputsVaultRoot(org);
  if (!outputsRoot) {
    return Response.json({ error: `Outputs vault not found for org "${org}"` }, { status: 404 });
  }

  const entries = fs.readdirSync(outputsRoot, { withFileTypes: true });
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP.has(entry.name)) continue;
    const abs = path.join(outputsRoot, entry.name);
    const relPath = path.relative(outputsRoot, abs);

    if (entry.isDirectory()) {
      dirs.push({
        kind: 'dir',
        name: entry.name,
        relPath,
        children: walkDir(abs, outputsRoot),
      });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(abs);
      files.push({
        kind: 'file',
        name: entry.name,
        relPath,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return Response.json({ vaultRoot: outputsRoot, root: [...dirs, ...files] });
}

function walkDir(abs: string, outputsRoot: string): TreeNode[] {
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP.has(entry.name)) continue;
    const childAbs = path.join(abs, entry.name);
    const relPath = path.relative(outputsRoot, childAbs);

    if (entry.isDirectory()) {
      dirs.push({
        kind: 'dir',
        name: entry.name,
        relPath,
        children: walkDir(childAbs, outputsRoot),
      });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(childAbs);
      files.push({
        kind: 'file',
        name: entry.name,
        relPath,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files];
}
