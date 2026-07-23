import { existsSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { RepoConfig, RepoKey } from './types.js';

type RepoConfigOverride = Partial<Omit<RepoConfig, 'key'>> & Pick<RepoConfig, 'key'>;

const REPO_KEYS: RepoKey[] = ['clearpath', 'cxportal', 'nonprofit-hub', 'auditos', 'gws-security'];

function repoPath(name: string): string {
  return resolve(homedir(), 'code', name);
}

function scenarioPath(localPath: string): string {
  return join(localPath, '.staging-verify', 'scenario.json');
}

function isRepoKey(value: unknown): value is RepoKey {
  return typeof value === 'string' && (REPO_KEYS as string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOverrideEntry(value: unknown): value is RepoConfigOverride {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (!isRepoKey(entry.key)) return false;
  const stringFields = [
    'localPath',
    'railwayProject',
    'stagingEnv',
    'verifyCommand',
    'migrateCommand',
    'seedCommand',
    'healthPath',
    'scenarioPath',
  ];
  for (const field of stringFields) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string') {
      return false;
    }
  }
  if (entry.prodEnvNames !== undefined && !isStringArray(entry.prodEnvNames)) {
    return false;
  }
  return true;
}

function normalizeRepoConfig(config: RepoConfig): RepoConfig {
  return {
    ...config,
    localPath: resolve(config.localPath),
    scenarioPath: config.scenarioPath ? resolve(config.scenarioPath) : scenarioPath(resolve(config.localPath)),
  };
}

export function defaultRepoRegistry(): RepoConfig[] {
  return [
    normalizeRepoConfig({
      key: 'clearpath',
      localPath: repoPath('clearpath'),
      railwayProject: 'awake-recreation',
      stagingEnv: 'staging',
      prodEnvNames: ['production'],
      verifyCommand: 'npm test',
      migrateCommand: 'npm run db:push',
      healthPath: '/api/health',
    }),
    normalizeRepoConfig({
      key: 'cxportal',
      localPath: repoPath('cxportal'),
      railwayProject: 'joyful-learning',
      stagingEnv: 'staging',
      prodEnvNames: ['production'],
      verifyCommand: 'npm run check',
      migrateCommand: 'npm run db:push',
      healthPath: '/api/health',
    }),
    normalizeRepoConfig({
      key: 'nonprofit-hub',
      localPath: repoPath('nonprofit-hub'),
      railwayProject: 'unique-perception',
      stagingEnv: 'staging',
      prodEnvNames: ['production'],
      verifyCommand: 'npm run check',
      migrateCommand: 'npm run db:push',
      healthPath: '/api/health',
    }),
    normalizeRepoConfig({
      key: 'auditos',
      localPath: repoPath('auditos'),
      railwayProject: 'miraculous-ambition',
      stagingEnv: 'staging',
      prodEnvNames: ['production'],
      verifyCommand: 'bin/verify.sh',
      healthPath: '/api/health',
    }),
    normalizeRepoConfig({
      key: 'gws-security',
      localPath: repoPath('gws-security'),
      railwayProject: 'gws-security',
      stagingEnv: 'staging',
      prodEnvNames: ['production'],
      verifyCommand: 'uv run python -m pytest',
      healthPath: '/api/health/db',
    }),
  ];
}

export function loadRepoRegistry(configPath?: string): RepoConfig[] {
  const defaults = defaultRepoRegistry();
  if (!configPath) return defaults;

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read repo config override at ${configPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Repo config override at ${configPath} is not valid JSON`);
  }
  let entries: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const maybeRepos = (parsed as { repos?: unknown }).repos;
    if (Array.isArray(maybeRepos)) {
      entries = maybeRepos;
    }
  }
  if (!entries || !entries.every(isOverrideEntry)) {
    throw new Error(`Invalid repo config override at ${configPath}`);
  }

  const merged = new Map<RepoKey, RepoConfig>(defaults.map((repo) => [repo.key, repo]));
  for (const override of entries) {
    const base = merged.get(override.key);
    if (!base) {
      throw new Error(`Unknown repo key in override: ${override.key}`);
    }
    merged.set(override.key, normalizeRepoConfig({
      ...base,
      ...override,
      prodEnvNames: override.prodEnvNames ?? base.prodEnvNames,
    }));
  }
  return Array.from(merged.values());
}

function candidatePaths(repo: RepoConfig): string[] {
  const candidates = new Set<string>([resolve(repo.localPath)]);
  if (existsSync(repo.localPath)) {
    try {
      candidates.add(realpathSync(repo.localPath));
    } catch {
      // Ignore missing/permission failures and fall back to the resolved path.
    }
  }
  return Array.from(candidates);
}

export function resolveRepo(registry: RepoConfig[], repoArg: string): RepoConfig {
  const byKey = registry.find((repo) => repo.key === repoArg);
  if (byKey) return byKey;

  const repoPathArg = resolve(repoArg);
  const byPath = registry.find((repo) => candidatePaths(repo).includes(repoPathArg));
  if (byPath) return byPath;

  throw new Error(`Unknown --repo '${repoArg}'. Known keys: ${REPO_KEYS.join(', ')}`);
}
