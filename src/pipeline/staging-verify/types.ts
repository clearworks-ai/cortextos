export type RepoKey = 'clearpath' | 'cxportal' | 'nonprofit-hub' | 'auditos' | 'gws-security';

export interface RepoConfig {
  key: RepoKey;
  localPath: string;
  railwayProject: string;
  stagingEnv: string;
  prodEnvNames: string[];
  verifyCommand: string;
  migrateCommand?: string;
  seedCommand?: string;
  healthPath: string;
  scenarioPath?: string;
}

export type StageName =
  | 'preflight'
  | 'apply'
  | 'deploy'
  | 'migrate'
  | 'seed'
  | 'drive'
  | 'read-state'
  | 'verify'
  | 'evidence'
  | 'emit'
  | 'teardown';

export type StageOutcome =
  | { kind: 'ok'; detail?: string }
  | { kind: 'transient'; detail: string }
  | { kind: 'fatal'; detail: string };

export interface RunContext {
  slug: string;
  repo: RepoConfig;
  buildOutputPath: string;
  buildOutputSha256: string;
  stagingUrl?: string;
  attempt: number;
  maxAttempts: number;
  runner: string;
  evidenceDir: string;
  ledgerPath?: string;
  secretPath?: string;
  keepDeploy: boolean;
  log: (line: string) => void;
  appliedGitSha?: string;
  appliedArtifactPath?: string;
  startedAt?: string;
  stageRecords?: StageRecord[];
}

export interface StageRecord {
  stage: StageName;
  attempt: number;
  startedAt: string;
  endedAt: string;
  outcome: StageOutcome['kind'];
  detail?: string;
}

export interface RunResult {
  ok: boolean;
  exitCode: 0 | 1 | 2 | 3 | 4;
  evidencePath?: string;
  ledgerRowJson?: string;
  stages: StageRecord[];
}

export interface Scenario {
  name: string;
  auth?: AuthStep;
  steps: DriveStep[];
  assertions: StateAssertion[];
}

export interface AuthStep {
  kind: 'form-login' | 'json-login';
  path: string;
  usernameEnv: string;
  passwordEnv: string;
  bodyTemplate: Record<string, string>;
  successStatus: number[];
}

export interface DriveStep {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  contentType?: 'application/json' | 'application/x-www-form-urlencoded';
  headers?: Record<string, string>;
  expectStatus: number[];
  captureJson?: Record<string, string>;
}

export interface StateAssertion {
  name: string;
  source: 'json-api' | 'db';
  endpoint?: string;
  jsonPath?: string;
  queryScript?: string;
  op: 'eq' | 'gte' | 'lte';
  expected: number;
}

export interface AssertionResult {
  name: string;
  source: 'json-api' | 'db';
  expected: number;
  actual: number | null;
  op: 'eq' | 'gte' | 'lte';
  pass: boolean;
  detail?: string;
}

export interface StagingVerifyEvidence {
  schema: 'staging-verify-evidence/v1';
  slug: string;
  ok: boolean;
  repo: string;
  staging_url: string;
  verify_command: string;
  exit_code: number;
  build_output_sha256: string;
  assertions: AssertionResult[];
  build_output_kind: 'git-ref';
  applied_git_sha: string;
  railway_project: string;
  staging_env: string;
  attempts: number;
  max_attempts: number;
  scenario: string;
  stages: StageRecord[];
  verify_output_tail: string;
  failure?: { stage: StageName; detail: string };
  started_at: string;
  finished_at: string;
  runner: string;
  tool_version: string;
}
