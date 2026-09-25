#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CORE = [
  "agent-browser",
  "bonesify",
  "codebase-reference",
  "coding-standards",
  "debugify",
  "detailify",
  "goalify",
  "graphify",
  "grilling",
  "impeccable",
  "implementify",
  "mapify",
  "mergify",
  "optional-capability",
  "planify",
  "ponytail",
  "researchify",
  "reviewify",
  "skill-creator",
  "skillify",
  "specify",
  "systematic-debugging",
  "task-observer",
  "tddify",
  "verify",
];

const BLOTATO = new Set([
  "brand-brief",
  "content-coach",
  "generate",
  "post-grader",
  "post-scheduler",
  "post-writer",
  "repurpose",
  "viral-hooks",
]);

const BLOTATO_ROLES = new Set(["knox-codex", "builddifferentprod-codex"]);
const MOXIE_ROLES = new Set(["pa-codex", "crm-codex"]);
const BARE_MCP = ["codebase-memory-mcp", "context7", "playwright"];

const POLICY_CLIENTS = ["codex", "claude", "opencode", "grok"];
const FLAG_KEYS = [
  "syncClaudeAiSkills",
  "syncClaudeAiPlugins",
  "grokClaudeMcps",
  "disableClaudeAiConnectors",
];
const EXPECTED_FLAGS = {
  syncClaudeAiSkills: false,
  syncClaudeAiPlugins: false,
  grokClaudeMcps: false,
  disableClaudeAiConnectors: true,
};

const LIVE_POLICY = "/Users/joshweiss/.config/agent-policies/CODING.md";
const LIVE_LINKS = {
  codex: "/Users/joshweiss/.codex/AGENTS.md",
  claude: "/Users/joshweiss/.claude/CLAUDE.md",
  opencode: "/Users/joshweiss/.config/opencode/AGENTS.md",
  grok: "/Users/joshweiss/.grok/AGENTS.md",
};
const KADRE = "/Users/joshweiss/code/Clients/kadre";
const USER_SKILLS = "/Users/joshweiss/.agents/skills";
const PROBE_SCRIPT = "/Users/joshweiss/agent-config-audit-wXignS/cleanup/probe_skill_discovery.mjs";
const PROBE_TIMEOUT_MS = 70000;
const ROLE_ROOTS = [
  ["auditmaster-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/auditmaster-codex"],
  ["builddifferentprod-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/builddifferentprod-codex"],
  ["crm-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/crm-codex"],
  ["frank2-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2-codex"],
  ["knox-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/knox-codex"],
  ["larry-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry-codex"],
  ["maven-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/maven-codex"],
  ["pa-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa-codex"],
  ["sage-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/sage-codex"],
  ["scout-codex", "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/scout-codex"],
  ["ophir-codex", "/Users/joshweiss/code/cortextos/orgs/personal/agents/ophir-codex"],
];

const FIXTURE_LINKS = {
  codex: ["clients", "codex", "AGENTS.md"],
  claude: ["clients", "claude", "CLAUDE.md"],
  opencode: ["clients", "opencode", "AGENTS.md"],
  grok: ["clients", "grok", "AGENTS.md"],
};

function sortNames(list) {
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))].sort();
}

function skillBase(name) {
  const text = String(name).trim();
  const idx = text.lastIndexOf(":");
  return (idx === -1 ? text : text.slice(idx + 1)).trim();
}

function normalizeSkills(list) {
  if (!Array.isArray(list)) return [];
  const names = [];
  for (const item of list) {
    const raw = typeof item === "string"
      ? item
      : item && typeof item === "object" && typeof item.name === "string"
        ? item.name
        : "";
    const base = skillBase(raw);
    if (base) names.push(base);
  }
  return names;
}

function errorCount(errors) {
  if (typeof errors === "number" && Number.isFinite(errors) && errors > 0) return errors;
  if (Array.isArray(errors)) return errors.length;
  return 0;
}

function expectedMcp(role) {
  const names = [...BARE_MCP];
  if (MOXIE_ROLES.has(role)) names.push("moxie");
  if (BLOTATO_ROLES.has(role)) names.push("blotato");
  return sortNames(names);
}

function mcpDrift(label, got, expected) {
  const actual = sortNames(got);
  const want = sortNames(expected);
  if (actual.length === want.length && actual.every((name, index) => name === want[index])) return null;
  return `${label} mcp drift: got ${actual.join(",") || "(none)"} expected ${want.join(",")}`;
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { status: err && err.code === "ENOENT" ? "missing" : "invalid", value: null };
  }
  try {
    return { status: "ok", value: JSON.parse(text) };
  } catch {
    return { status: "invalid", value: null };
  }
}

function resolvesToPolicy(linkPath, policyPath) {
  let expected;
  try {
    expected = fs.realpathSync(policyPath);
  } catch {
    return false;
  }
  let st;
  try {
    st = fs.lstatSync(linkPath);
  } catch {
    return false;
  }
  if (!st.isSymbolicLink()) return false;
  try {
    return fs.realpathSync(linkPath) === expected;
  } catch {
    return false;
  }
}

function isBrokenSymlink(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return false;
  }
  if (!st.isSymbolicLink()) return false;
  try {
    fs.statSync(abs);
    return false;
  } catch (err) {
    return Boolean(err && err.code === "ENOENT");
  }
}

function walkBroken(dir, relBase) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const ent of entries) {
    const rel = `${relBase}/${ent.name}`;
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      if (isBrokenSymlink(abs)) found.push(rel);
      continue;
    }
    if (ent.isDirectory()) found.push(...walkBroken(abs, rel));
  }
  return found;
}

function brokenOneLevel(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const found = [];
  for (const ent of entries) {
    if (!ent.isSymbolicLink()) continue;
    if (isBrokenSymlink(path.join(dir, ent.name))) found.push(ent.name);
  }
  return found;
}

function applyFlags(flags, drift) {
  const out = {};
  for (const key of FLAG_KEYS) {
    const value = flags ? flags[key] : undefined;
    out[key] = value === true;
    if (typeof value !== "boolean") drift.push(`flag ${key} missing`);
    else if (value !== EXPECTED_FLAGS[key]) drift.push(`flag ${key} drifted`);
  }
  return out;
}

function evaluate(input) {
  const drift = [];
  const policyLinks = {};
  for (const client of POLICY_CLIENTS) {
    policyLinks[client] = input.policyLinks[client] === true;
    if (!policyLinks[client]) drift.push(`policy link ${client} drifted`);
  }

  const catalogErrors = input.catalogErrors;
  const catalogCounts = input.catalogCounts || { bare: 0, roles: {} };
  if (input.catalogProblem) drift.push(input.catalogProblem);
  if (catalogErrors > 0) drift.push(`catalog errors ${catalogErrors}`);

  const bareSkills = input.bareSkills instanceof Set ? input.bareSkills : new Set(input.bareSkills || []);
  const roleSkills = input.roleSkills || {};
  let corePresent = CORE.every((name) => bareSkills.has(name));
  for (const name of CORE) {
    if (!bareSkills.has(name)) drift.push(`missing core skill ${name} in bare`);
  }
  for (const role of Object.keys(roleSkills).sort()) {
    const skills = roleSkills[role];
    for (const name of CORE) {
      if (!skills.has(name)) {
        corePresent = false;
        drift.push(`missing core skill ${name} in ${role}`);
      }
    }
  }

  const forbidden = new Set();
  const noteForbidden = (place, role, names) => {
    const blotatoAllowed = role !== null && BLOTATO_ROLES.has(role);
    for (const name of names) {
      if (name === "the-humanizer" || (BLOTATO.has(name) && !blotatoAllowed)) {
        forbidden.add(name);
        drift.push(`forbidden skill ${name} in ${place}`);
      }
    }
  };
  noteForbidden("bare", null, bareSkills);
  for (const role of Object.keys(roleSkills).sort()) noteForbidden(role, role, roleSkills[role]);

  const bareMcp = sortNames(input.bareMcp || []);
  const bareMsg = mcpDrift("bare", bareMcp, BARE_MCP);
  if (bareMsg) drift.push(bareMsg);
  if (input.mcpProblem) drift.push(input.mcpProblem);

  const roleMcp = {};
  const projectionDrift = [];
  for (const role of Object.keys(input.roleMcp || {}).sort()) {
    const got = sortNames(input.roleMcp[role] || []);
    roleMcp[role] = got;
    const msg = mcpDrift(role, got, expectedMcp(role));
    if (msg) projectionDrift.push(msg);
  }
  drift.push(...projectionDrift);
  if (input.extraDrift) drift.push(...input.extraDrift);

  const flags = applyFlags(input.flags, drift);
  const brokenSymlinks = sortNames(input.brokenSymlinks || []);
  for (const name of brokenSymlinks) drift.push(`broken symlink ${name}`);

  return {
    drift: sortNames(drift),
    fields: {
      policyLinks,
      catalogErrors,
      catalogCounts,
      corePresent,
      forbiddenDefaultSkills: sortNames([...forbidden]),
      bareMcp,
      roleMcp,
      flags,
      brokenSymlinks,
      projectionDrift: sortNames(projectionDrift),
    },
  };
}

function loadFixture(dir) {
  const policy = path.join(dir, "policy", "CODING.md");
  const policyLinks = {};
  for (const client of POLICY_CLIENTS) {
    policyLinks[client] = resolvesToPolicy(path.join(dir, ...FIXTURE_LINKS[client]), policy);
  }

  const extraDrift = [];
  const catalogRead = readJson(path.join(dir, "catalog.json"));
  let catalogProblem = null;
  let catalogErrors = 0;
  let bareSkills = new Set();
  const roleSkills = {};
  const catalogCounts = { bare: 0, roles: {} };
  if (catalogRead.status !== "ok" || !catalogRead.value || typeof catalogRead.value !== "object" || Array.isArray(catalogRead.value)) {
    catalogProblem = catalogRead.status === "missing" ? "catalog missing" : "catalog invalid";
  } else {
    const bare = catalogRead.value.bare;
    const bareList = bare && bare.skills;
    bareSkills = new Set(normalizeSkills(bareList));
    catalogCounts.bare = Array.isArray(bareList) ? bareList.length : 0;
    catalogErrors += errorCount(bare && bare.errors);
    const roles = catalogRead.value.roles && typeof catalogRead.value.roles === "object" ? catalogRead.value.roles : {};
    for (const role of Object.keys(roles)) {
      const list = roles[role] && roles[role].skills;
      roleSkills[role] = new Set(normalizeSkills(list));
      catalogCounts.roles[role] = Array.isArray(list) ? list.length : 0;
      catalogErrors += errorCount(roles[role] && roles[role].errors);
    }
  }

  const mcpRead = readJson(path.join(dir, "mcp.json"));
  let mcpProblem = null;
  let bareMcp = [];
  const roleMcp = {};
  if (mcpRead.status !== "ok" || !mcpRead.value || typeof mcpRead.value !== "object" || Array.isArray(mcpRead.value)) {
    mcpProblem = mcpRead.status === "missing" ? "mcp missing" : "mcp invalid";
  } else {
    bareMcp = Array.isArray(mcpRead.value.bare) ? mcpRead.value.bare.filter((name) => typeof name === "string") : [];
    const roles = mcpRead.value.roles && typeof mcpRead.value.roles === "object" ? mcpRead.value.roles : {};
    for (const role of Object.keys(roles)) {
      const list = roles[role];
      roleMcp[role] = Array.isArray(list) ? list.filter((name) => typeof name === "string") : [];
    }
  }

  const flagsRead = readJson(path.join(dir, "flags.json"));
  let flags = {};
  if (flagsRead.status !== "ok" || !flagsRead.value || typeof flagsRead.value !== "object" || Array.isArray(flagsRead.value)) {
    extraDrift.push(flagsRead.status === "missing" ? "flags missing" : "flags invalid");
  } else {
    flags = flagsRead.value;
  }

  const linksDir = path.join(dir, "links");
  let brokenSymlinks = [];
  if (!fs.existsSync(linksDir)) extraDrift.push("links directory missing");
  else brokenSymlinks = walkBroken(linksDir, "links");

  return evaluate({
    policyLinks,
    catalogErrors,
    catalogCounts,
    catalogProblem,
    bareSkills,
    roleSkills,
    bareMcp,
    roleMcp,
    mcpProblem,
    flags,
    brokenSymlinks,
    extraDrift,
  });
}

function runCmd(cmd, args, cwd) {
  try {
    const res = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    return { stdout: res.stdout || "" };
  } catch {
    return { stdout: "" };
  }
}

function parseCodex(text) {
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const names = [];
  for (const item of parsed) {
    if (item && item.enabled === true && typeof item.name === "string" && item.name.trim()) names.push(item.name.trim());
  }
  return names;
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseClaude(text) {
  const names = [];
  for (const line of stripAnsi(text).split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(":")) continue;
    if (trimmed.toLowerCase().includes("checking mcp server health")) continue;
    const name = trimmed.split(":")[0].trim();
    if (name) names.push(name);
  }
  return names;
}

function parseGrok(text) {
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Object.prototype.hasOwnProperty.call(parsed, "mcpServers")) return null;
  const servers = parsed.mcpServers;
  const names = [];
  if (Array.isArray(servers)) {
    for (const item of servers) {
      if (typeof item === "string" && item.trim()) {
        names.push(item.trim());
        continue;
      }
      if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim()) continue;
      const enabled = !Object.prototype.hasOwnProperty.call(item, "enabled") || item.enabled === true;
      if (enabled) names.push(item.name.trim());
    }
    return names;
  }
  if (!servers || typeof servers !== "object") return null;
  for (const [key, value] of Object.entries(servers)) {
    if (!value || typeof value !== "object") {
      if (key.trim()) names.push(key.trim());
      continue;
    }
    const enabled = !Object.prototype.hasOwnProperty.call(value, "enabled") || value.enabled === true;
    if (!enabled) continue;
    const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : key.trim();
    if (name) names.push(name);
  }
  return names;
}

function readGrokMcps(text) {
  let section = "";
  let found;
  for (const line of text.split(/\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "compat.claude") continue;
    const match = line.match(/^\s*mcps\s*=\s*(true|false)\b/);
    if (match) found = match[1] === "true";
  }
  return found;
}

function isKadreCwd(cwd) {
  return path.resolve(cwd) === path.resolve(KADRE) || path.basename(cwd) === "kadre";
}

function runCatalogProbe(outputName, cwds) {
  const outFile = path.join(path.dirname(PROBE_SCRIPT), outputName);
  let res;
  try {
    res = spawnSync(process.execPath, [PROBE_SCRIPT, outputName, ...cwds], {
      cwd: path.dirname(PROBE_SCRIPT),
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
  } catch {
    return null;
  }
  if (!res || res.error || res.status !== 0) return null;
  const read = readJson(outFile);
  if (read.status !== "ok" || !read.value || typeof read.value !== "object" || !Array.isArray(read.value.data)) return null;
  return read.value.data;
}

function consumeCatalogRows(rows, kind, bareSkills, roleSkills, catalogCounts) {
  let catalogErrors = 0;
  let sawBare = false;
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.cwd !== "string") continue;
    const names = normalizeSkills(row.skills);
    const count = Array.isArray(row.skills) ? row.skills.length : 0;
    const errors = errorCount(row.errors);
    if (kind === "bare") {
      if (!isKadreCwd(row.cwd)) continue;
      sawBare = true;
      for (const name of names) bareSkills.add(name);
      catalogCounts.bare = count;
      catalogErrors += errors;
      continue;
    }
    const role = path.basename(row.cwd);
    roleSkills[role] = new Set(names);
    catalogCounts.roles[role] = count;
    catalogErrors += errors;
  }
  return { catalogErrors, sawBare };
}

function loadLiveCatalog() {
  const extraDrift = [];
  const bareSkills = new Set();
  const roleSkills = {};
  const catalogCounts = { bare: 0, roles: {} };
  let catalogErrors = 0;
  let sawBare = false;
  let bareProbeOk = false;
  const probes = [
    ["discovery-doctor-live-bare.json", [KADRE], "bare"],
    ["discovery-doctor-live-roles-a.json", ROLE_ROOTS.slice(0, 6).map(([, root]) => root), "roles"],
    ["discovery-doctor-live-roles-b.json", ROLE_ROOTS.slice(6).map(([, root]) => root), "roles"],
  ];
  for (const [outputName, cwds, kind] of probes) {
    const rows = runCatalogProbe(outputName, cwds);
    if (!rows) {
      extraDrift.push(`catalog probe failed ${outputName}`);
      continue;
    }
    if (kind === "bare") bareProbeOk = true;
    const consumed = consumeCatalogRows(rows, kind, bareSkills, roleSkills, catalogCounts);
    catalogErrors += consumed.catalogErrors;
    if (consumed.sawBare) sawBare = true;
  }
  if (bareProbeOk && !sawBare) extraDrift.push("catalog bare missing");
  return { catalogProblem: null, catalogErrors, bareSkills, roleSkills, extraDrift, catalogCounts };
}

function loadLiveFlags(extraDrift) {
  const flags = {};
  const settings = readJson("/Users/joshweiss/.claude/settings.json");
  if (settings.status !== "ok" || !settings.value || typeof settings.value !== "object" || Array.isArray(settings.value)) {
    extraDrift.push(settings.status === "missing" ? "claude settings missing" : "claude settings invalid");
  } else {
    for (const key of ["syncClaudeAiSkills", "syncClaudeAiPlugins", "disableClaudeAiConnectors"]) {
      if (typeof settings.value[key] === "boolean") flags[key] = settings.value[key];
    }
  }
  let toml;
  try {
    toml = fs.readFileSync("/Users/joshweiss/.grok/config.toml", "utf8");
  } catch {
    extraDrift.push("grok config missing");
    return flags;
  }
  const mcps = readGrokMcps(toml);
  if (typeof mcps !== "boolean") extraDrift.push("grok claude mcps missing");
  else flags.grokClaudeMcps = mcps;
  return flags;
}

function loadLiveMcp(extraDrift) {
  const bareParsed = parseCodex(runCmd("codex", ["mcp", "list", "--json"], KADRE).stdout);
  let bareMcp = [];
  if (!bareParsed) extraDrift.push("bare mcp unavailable");
  else bareMcp = bareParsed;

  const roleMcp = {};
  for (const [role, root] of ROLE_ROOTS) {
    if (!fs.existsSync(root)) {
      extraDrift.push(`role missing ${role}`);
      continue;
    }
    const parsed = parseCodex(runCmd("codex", ["mcp", "list", "--json"], root).stdout);
    if (!parsed) {
      extraDrift.push(`${role} mcp unavailable`);
      continue;
    }
    roleMcp[role] = parsed;
  }

  const claudeStdout = runCmd("claude", ["mcp", "list"], KADRE).stdout;
  if (!claudeStdout.trim()) extraDrift.push("claude mcp unavailable");
  else {
    const msg = mcpDrift("claude", parseClaude(claudeStdout), BARE_MCP);
    if (msg) extraDrift.push(msg);
  }

  const grokStdout = runCmd("grok", ["inspect", "--json"], KADRE).stdout;
  const grokNames = parseGrok(grokStdout);
  if (!grokNames) extraDrift.push("grok mcp unavailable");
  else {
    const msg = mcpDrift("grok", grokNames, BARE_MCP);
    if (msg) extraDrift.push(msg);
  }
  return { bareMcp, roleMcp };
}

function loadLiveBroken(extraDrift) {
  const broken = [];
  const user = brokenOneLevel(USER_SKILLS);
  if (!user) extraDrift.push("skills directory missing user");
  else for (const name of user) broken.push(`.agents/skills/${name}`);
  for (const [role, root] of ROLE_ROOTS) {
    const dir = path.join(root, ".agents", "skills");
    const found = brokenOneLevel(dir);
    if (!found) {
      if (fs.existsSync(root)) extraDrift.push(`skills directory missing ${role}`);
      continue;
    }
    for (const name of found) broken.push(`${role}/.agents/skills/${name}`);
  }
  return broken;
}

function loadLive() {
  const policyLinks = {};
  for (const client of POLICY_CLIENTS) policyLinks[client] = resolvesToPolicy(LIVE_LINKS[client], LIVE_POLICY);
  const catalog = loadLiveCatalog();
  const flags = loadLiveFlags(catalog.extraDrift);
  const mcp = loadLiveMcp(catalog.extraDrift);
  const brokenSymlinks = loadLiveBroken(catalog.extraDrift);
  return evaluate({
    policyLinks,
    catalogErrors: catalog.catalogErrors,
    catalogCounts: catalog.catalogCounts,
    catalogProblem: catalog.catalogProblem,
    bareSkills: catalog.bareSkills,
    roleSkills: catalog.roleSkills,
    bareMcp: mcp.bareMcp,
    roleMcp: mcp.roleMcp,
    flags,
    brokenSymlinks,
    extraDrift: catalog.extraDrift,
  });
}

function matchesSecret(text) {
  return /sk-[A-Za-z0-9_-]{8,}/.test(text) || /Bearer\s+\S+/.test(text) || /eyJ[A-Za-z0-9_-]{10,}/.test(text);
}

function redactValue(value) {
  if (typeof value === "string") return matchesSecret(value) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactValue(value[key]);
    return out;
  }
  return value;
}

function scrub(text) {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}/g, "[redacted]");
}

function emit(report) {
  process.stdout.write(`${scrub(JSON.stringify(redactValue(report)))}\n`);
}

function usage() {
  process.stderr.write("usage: node scripts/agent-env-doctor.mjs --fixture <dir> | --live\n");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--live") {
    emit(loadLive());
    return;
  }
  if (args.length === 2 && args[0] === "--fixture") {
    let st;
    try {
      st = fs.statSync(args[1]);
    } catch {
      usage();
    }
    if (!st.isDirectory()) usage();
    emit(loadFixture(args[1]));
    return;
  }
  usage();
}

main();
