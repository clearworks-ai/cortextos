#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../../../../");
const MEETINGS_DIR = path.join(REPO_ROOT, "orgs/clearworksai/knowledge/meetings");
const DRY_RUN_DIR = path.join(SCRIPT_DIR, "out-dryrun");
const DEFAULT_RUN_DATE = "2026-07-30";
const SOURCE_RE = /\*\*Source:\*\*\s+fireflies:([^\s|]+)/;
const CLEARWORKS_DOMAINS = new Set(["clearworks.ai"]);

function collapseWs(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function slugify(value, fallback = "note") {
  const slug = collapseWs(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function escapeCell(value) {
  return collapseWs(value).replace(/\|/g, "/");
}

function readDateText(raw) {
  if (!raw) {
    return "1970-01-01";
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return "1970-01-01";
  }
  return parsed.toISOString().slice(0, 10);
}

function parseJsonish(value, fallback) {
  if (value == null) {
    return fallback;
  }
  if (Array.isArray(value) || typeof value === "object") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractEmails(row) {
  const emails = [];
  const participants = parseJsonish(row.participants, []);
  if (Array.isArray(participants)) {
    for (const participant of participants) {
      const text = collapseWs(participant);
      if (text.includes("@")) {
        emails.push(text.toLowerCase());
      }
    }
  }
  const calendarAttendees = parseJsonish(row.calendar_attendees, []);
  if (Array.isArray(calendarAttendees)) {
    for (const attendee of calendarAttendees) {
      if (attendee && typeof attendee === "object") {
        const email = collapseWs(attendee.email);
        if (email) {
          emails.push(email.toLowerCase());
        }
      }
    }
  }
  const hostEmail = collapseWs(row.host_email).toLowerCase();
  if (hostEmail) {
    emails.push(hostEmail);
  }
  return unique(emails);
}

function attendeeSummary(row) {
  const names = [];
  const participants = parseJsonish(row.participants, []);
  if (Array.isArray(participants)) {
    for (const participant of participants) {
      const text = collapseWs(participant);
      if (text) {
        names.push(text);
      }
    }
  }
  const calendarAttendees = parseJsonish(row.calendar_attendees, []);
  if (Array.isArray(calendarAttendees)) {
    for (const attendee of calendarAttendees) {
      if (attendee && typeof attendee === "object") {
        const label = collapseWs(attendee.email || attendee.name);
        if (label) {
          names.push(label);
        }
      }
    }
  }
  const deduped = unique(names);
  return deduped.length ? deduped.join(", ") : "none";
}

function clientDomain(row) {
  for (const email of extractEmails(row)) {
    const [, domain = ""] = email.split("@");
    if (!domain || CLEARWORKS_DOMAINS.has(domain)) {
      continue;
    }
    const host = domain.split(".")[0];
    if (host && host !== "www") {
      return host;
    }
  }
  return "";
}

function deriveClientName(row) {
  const domain = clientDomain(row);
  if (domain) {
    return domain.replace(/[-_]+/g, " ");
  }
  const title = collapseWs(row.title);
  if (!title) {
    return "clearworks";
  }
  const first = title.split(/[-|:·]/)[0];
  return collapseWs(first) || "clearworks";
}

function deriveTopic(row, clientName) {
  const title = collapseWs(row.title);
  if (!title) {
    return "meeting";
  }
  const segments = title.split(/\s[-|:·]\s/).map(collapseWs).filter(Boolean);
  if (segments.length > 1) {
    const prefixSlug = slugify(segments[0], "");
    const clientSlug = slugify(clientName, "");
    const prefixCompact = prefixSlug.replace(/-/g, "");
    const clientCompact = clientSlug.replace(/-/g, "");
    if (
      prefixCompact &&
      clientCompact &&
      (
        prefixCompact === clientCompact ||
        prefixCompact.includes(clientCompact) ||
        clientCompact.includes(prefixCompact)
      )
    ) {
      return segments.slice(1).join(" - ");
    }
  }
  const clientWords = slugify(clientName, "").split("-").filter(Boolean);
  let cleaned = title;
  for (const word of clientWords) {
    if (!word) {
      continue;
    }
    const pattern = new RegExp(`\\b${word}\\b`, "ig");
    cleaned = cleaned.replace(pattern, "");
  }
  cleaned = collapseWs(cleaned.replace(/^[-|:·\s]+/, ""));
  return cleaned || title;
}

function toBulletList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => collapseWs(typeof item === "string" ? item : item?.outcome || item?.decision || item?.text || item?.action)).filter(Boolean);
  }
  return String(value)
    .split(/\n|•|;/)
    .map((item) => collapseWs(item.replace(/^[-*]\s*/, "")))
    .filter(Boolean);
}

function outcomeLines(row) {
  const lines = unique([
    ...toBulletList(row.summary_overview),
    ...toBulletList(row.summary_bullets),
    ...toBulletList(parseJsonish(row.outcome_items, [])),
  ]);
  return lines.length ? lines : ["none"];
}

function decisionLines(row) {
  const lines = unique(toBulletList(parseJsonish(row.decision_items, [])));
  return lines.length ? lines : ["none"];
}

function actionRows(row) {
  const rows = [];
  const actionItems = parseJsonish(row.action_items, []);
  if (Array.isArray(actionItems)) {
    for (const item of actionItems) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const task = collapseWs(item.action || item.task || item.text);
      if (!task) {
        continue;
      }
      rows.push([
        escapeCell(task),
        escapeCell(item.owner || item.assignee || ""),
        escapeCell(item.dueDate || item.due || ""),
      ]);
    }
  }
  for (const summaryItem of toBulletList(row.summary_action_items)) {
    rows.push([escapeCell(summaryItem), "", ""]);
  }
  const followUps = parseJsonish(row.follow_up_items, []);
  if (Array.isArray(followUps)) {
    for (const item of followUps) {
      const task = collapseWs(item?.action || item?.text || item);
      if (task) {
        rows.push([escapeCell(task), escapeCell(item?.owner || ""), escapeCell(item?.dueDate || "")]);
      }
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const rowValue of rows) {
    const key = rowValue.join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(rowValue);
  }
  return deduped;
}

export function renderMeetingNote(row, { runDate = DEFAULT_RUN_DATE } = {}) {
  const dateText = readDateText(row.date);
  const clientName = deriveClientName(row);
  const topic = deriveTopic(row, clientName);
  const clientSlug = slugify(clientName, "client");
  const topicSlug = slugify(topic, "meeting");
  const transcriptId = collapseWs(row.fireflies_transcript_id);
  const sourceToken = `fireflies:${transcriptId} · clearpath-backfill:${runDate}`;
  const filename = `${dateText}-${clientSlug}-${topicSlug}.md`;
  const actions = actionRows(row);
  const organizer = collapseWs(row.host_email || row.host_name);
  const lines = [
    `# ${dateText} · ${clientName} · ${topic}`,
    "",
    `**Attendees:** ${attendeeSummary(row)} | **Source:** ${sourceToken} | **Processed:** yes`,
    "",
    "## Meeting",
    "",
    `- Date: ${dateText}`,
    `- Client: ${clientName}`,
    `- Topic: ${topic}`,
  ];
  if (organizer) {
    lines.push(`- Organizer: ${organizer}`);
  }
  lines.push("", "## Outcomes", "");
  for (const outcome of outcomeLines(row)) {
    lines.push(`- ${outcome}`);
  }
  lines.push("", "## Action Items", "", "| Task | Owner | Due |", "|---|---|---|");
  if (actions.length) {
    for (const [task, owner, due] of actions) {
      lines.push(`| ${task} | ${owner} | ${due} |`);
    }
  } else {
    lines.push("| none | | |");
  }
  lines.push("", "## Decisions", "");
  for (const decision of decisionLines(row)) {
    lines.push(`- ${decision}`);
  }
  lines.push("", "## Deal-State Changes", "", "- no change", "");
  return {
    filename,
    sourceId: transcriptId,
    body: lines.join("\n"),
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readExistingSourceIds(dirPath) {
  const found = new Set();
  try {
    const entries = await fs.readdir(dirPath);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const body = await fs.readFile(path.join(dirPath, entry), "utf8");
      const match = body.match(SOURCE_RE);
      if (match?.[1]) {
        found.add(match[1]);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return found;
}

async function nextAvailablePath(baseDir, filename, sourceId) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let counter = 1;
  while (true) {
    const candidate = counter === 1 ? filename : `${stem}-${counter}${ext}`;
    const fullPath = path.join(baseDir, candidate);
    try {
      const existing = await fs.readFile(fullPath, "utf8");
      const match = existing.match(SOURCE_RE);
      if (match?.[1] === sourceId) {
        return { fullPath, filename: candidate, duplicate: true };
      }
      counter += 1;
      continue;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { fullPath, filename: candidate, duplicate: false };
      }
      throw error;
    }
  }
}

async function loadRows({ orgId }) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("missing DATABASE_URL; run this via `railway run -- node dump-meetings.mjs` after linking Clearpath production");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  try {
    const distinct = await pool.query("SELECT DISTINCT org_id FROM fireflies_meetings WHERE is_excluded = false ORDER BY org_id ASC");
    const orgIds = distinct.rows.map((row) => collapseWs(row.org_id)).filter(Boolean);
    if (orgIds.length > 1 && !orgId) {
      throw new Error(`multiple org_ids found: ${orgIds.join(", ")}; rerun with --org <id>`);
    }
    const effectiveOrg = orgId || orgIds[0] || "";
    const clauses = ["is_excluded = false"];
    const params = [];
    if (effectiveOrg) {
      params.push(effectiveOrg);
      clauses.push(`org_id = $${params.length}`);
    }
    const query = `
      SELECT id, fireflies_transcript_id, org_id, title, date, host_email, host_name,
             participants, calendar_attendees, summary_overview, summary_bullets,
             summary_action_items, summary_keywords, transcript_data, action_items,
             decision_items, outcome_items, follow_up_items, source, is_excluded, created_at
      FROM fireflies_meetings
      WHERE ${clauses.join(" AND ")}
      ORDER BY date ASC NULLS LAST, id ASC
    `;
    const result = await pool.query(query, params);
    return { rows: result.rows, orgIds, effectiveOrg };
  } finally {
    await pool.end();
  }
}

async function writeOutputs(rows, { commit, runDate }) {
  const targetDir = commit ? MEETINGS_DIR : DRY_RUN_DIR;
  await ensureDir(targetDir);
  const existingSourceIds = await readExistingSourceIds(MEETINGS_DIR);
  const written = [];
  let skippedDup = 0;
  let collisions = 0;

  for (const row of rows) {
    const rendered = renderMeetingNote(row, { runDate });
    if (!rendered.sourceId || existingSourceIds.has(rendered.sourceId)) {
      skippedDup += 1;
      continue;
    }
    const nextPath = await nextAvailablePath(targetDir, rendered.filename, rendered.sourceId);
    if (nextPath.duplicate) {
      skippedDup += 1;
      continue;
    }
    if (nextPath.filename !== rendered.filename) {
      collisions += 1;
    }
    await fs.writeFile(nextPath.fullPath, rendered.body, "utf8");
    written.push({ ...rendered, filename: nextPath.filename, path: nextPath.fullPath });
  }

  return { written, skippedDup, collisions, targetDir };
}

function parseArgs(argv) {
  const args = { commit: false, org: "", runDate: DEFAULT_RUN_DATE };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--commit") {
      args.commit = true;
      continue;
    }
    if (value === "--org") {
      args.org = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--run-date") {
      args.runDate = argv[index + 1] || DEFAULT_RUN_DATE;
      index += 1;
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { rows, orgIds, effectiveOrg } = await loadRows({ orgId: args.org });
  const { written, skippedDup, collisions, targetDir } = await writeOutputs(rows, {
    commit: args.commit,
    runDate: args.runDate,
  });
  console.log(`Fetched ${rows.length} rows for org ${effectiveOrg || "all"} (distinct org_ids: ${orgIds.join(", ") || "none"})`);
  console.log(`Mode: ${args.commit ? "commit" : "dry-run"} -> ${targetDir}`);
  console.log(`Would/write count: ${written.length}`);
  console.log(`Skip dup: ${skippedDup}`);
  console.log(`Filename collisions: ${collisions}`);
  if (!args.commit) {
    const samples = written.slice(0, 3);
    for (const sample of samples) {
      console.log(`\n--- SAMPLE: ${sample.filename} ---\n${sample.body}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
