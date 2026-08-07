import { readFileSync, writeFileSync } from 'fs';
import { buildStatusReportPlan, parseClientFile } from '../../../src/bus/delivery-status';

const md = readFileSync(process.argv[2], 'utf8');
const slug = process.argv[3];
const today = process.argv[4];

const state = parseClientFile(slug, md);
const plan = buildStatusReportPlan({
  slug,
  clientFileMarkdown: md,
  today,
  interactions: [
    {
      summary:
        "it'll be a day or so, but I'm going to analyze the interviews and send them both emails with Mark on copy.",
      date: '2026-08-03',
    },
  ],
} as any);

const out = { parsed: state, plan };
writeFileSync(process.argv[5], JSON.stringify(out, null, 2));
console.log(JSON.stringify({ action: plan.action, classification: plan.classification, skipReason: plan.skipReason }, null, 2));
