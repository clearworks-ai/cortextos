import fs from 'fs';
import { NextRequest } from 'next/server';
import { getOutputsVaultRoot, resolveOutputsVaultPath } from '@/lib/vault';

export const dynamic = 'force-dynamic';

const ORG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const org = url.searchParams.get('org');
  const relPath = url.searchParams.get('path');

  if (!org || !ORG_RE.test(org)) {
    return Response.json({ error: 'Invalid org parameter' }, { status: 400 });
  }

  if (!relPath) {
    return Response.json({ error: 'path query param required' }, { status: 400 });
  }

  if (!relPath.endsWith('.md')) {
    return Response.json({ error: 'Only .md files are supported' }, { status: 400 });
  }

  const outputsRoot = getOutputsVaultRoot(org);
  if (!outputsRoot) {
    return Response.json({ error: `Outputs vault not found for org "${org}"` }, { status: 404 });
  }

  const abs = resolveOutputsVaultPath(outputsRoot, relPath);
  if (!abs) {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }

  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }

  const stat = fs.statSync(abs);
  return Response.json({
    content: fs.readFileSync(abs, 'utf-8'),
    mtimeMs: stat.mtimeMs,
  });
}
