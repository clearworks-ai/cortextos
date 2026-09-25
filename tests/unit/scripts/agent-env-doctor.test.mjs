import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const doctor = path.join(repoRoot, "scripts/agent-env-doctor.mjs");

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

const BARE_MCP = ["codebase-memory-mcp", "context7", "playwright"];
const BLOTATO_SKILLS = [
  "brand-brief",
  "content-coach",
  "generate",
  "post-grader",
  "post-scheduler",
  "post-writer",
  "repurpose",
  "viral-hooks",
];

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function linkTo(target, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const rel = path.relative(path.dirname(dest), target);
  fs.symlinkSync(rel, dest);
}

function skillList(extra = []) {
  return CORE.map((name) => (name === "impeccable" ? "impeccable:impeccable" : name)).concat(extra);
}

function makeCleanFixture(dir) {
  const policy = path.join(dir, "policy", "CODING.md");
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  fs.writeFileSync(
    policy,
    "coding policy\nBearer super-secret-token\nsk-testSecretKey12\neyJhbGciOiJIUzI1NiJ9\n",
  );
  linkTo(policy, path.join(dir, "clients/codex/AGENTS.md"));
  linkTo(policy, path.join(dir, "clients/claude/CLAUDE.md"));
  linkTo(policy, path.join(dir, "clients/opencode/AGENTS.md"));
  linkTo(policy, path.join(dir, "clients/grok/AGENTS.md"));
  fs.mkdirSync(path.join(dir, "links"), { recursive: true });
  linkTo(policy, path.join(dir, "links/ok"));

  const plain = skillList();
  const blotato = skillList(BLOTATO_SKILLS);
  writeJson(path.join(dir, "catalog.json"), {
    bare: { errors: 0, skills: plain },
    roles: {
      "auditmaster-codex": { errors: 0, skills: plain },
      "builddifferentprod-codex": { errors: 0, skills: blotato },
      "crm-codex": { errors: 0, skills: plain },
      "knox-codex": { errors: 0, skills: blotato },
      "larry-codex": { errors: 0, skills: plain },
      "pa-codex": { errors: 0, skills: plain },
    },
  });
  writeJson(path.join(dir, "mcp.json"), {
    bare: [...BARE_MCP],
    roles: {
      "auditmaster-codex": [...BARE_MCP],
      "builddifferentprod-codex": [...BARE_MCP, "blotato"],
      "crm-codex": [...BARE_MCP, "moxie"],
      "knox-codex": [...BARE_MCP, "blotato"],
      "larry-codex": [...BARE_MCP],
      "pa-codex": [...BARE_MCP, "moxie"],
    },
  });
  writeJson(path.join(dir, "flags.json"), {
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
    grokClaudeMcps: false,
    disableClaudeAiConnectors: true,
  });
}

function runDoctor(dir) {
  const res = spawnSync(process.execPath, [doctor, "--fixture", dir], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
  assert.equal(res.status, 0, combined);
  assert.doesNotMatch(res.stdout, /sk-[A-Za-z0-9_-]{8,}/);
  assert.doesNotMatch(res.stdout, /Bearer\s+\S+/);
  assert.doesNotMatch(res.stdout, /eyJ[A-Za-z0-9_-]{10,}/);
  assert.equal(res.stdout.trim().startsWith("{"), true);
  return JSON.parse(res.stdout);
}

test("clean fixture reports no drift and the core skill set", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-doctor-"));
  try {
    makeCleanFixture(dir);
    const report = runDoctor(dir);
    assert.deepEqual(report.drift, []);
    assert.equal(report.fields.corePresent, true);
    assert.equal(report.fields.catalogErrors, 0);
    assert.deepEqual(report.fields.forbiddenDefaultSkills, []);
    assert.deepEqual(report.fields.brokenSymlinks, []);
    assert.deepEqual(report.fields.projectionDrift, []);
    assert.deepEqual(report.fields.policyLinks, {
      codex: true,
      claude: true,
      opencode: true,
      grok: true,
    });
    assert.deepEqual(report.fields.bareMcp, ["codebase-memory-mcp", "context7", "playwright"]);
    assert.deepEqual(report.fields.roleMcp["pa-codex"], ["codebase-memory-mcp", "context7", "moxie", "playwright"]);
    assert.deepEqual(report.fields.flags, {
      syncClaudeAiSkills: false,
      syncClaudeAiPlugins: false,
      grokClaudeMcps: false,
      disableClaudeAiConnectors: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken symlink is drift and stdout stays free of secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-doctor-"));
  try {
    makeCleanFixture(dir);
    fs.symlinkSync("missing-target", path.join(dir, "links", "dangling-skill"));
    const report = runDoctor(dir);
    assert.ok(report.drift.length > 0);
    assert.ok(report.drift.some((item) => item.includes("dangling-skill")));
    assert.ok(report.fields.brokenSymlinks.some((item) => item.includes("dangling-skill")));
    assert.equal(report.fields.corePresent, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
