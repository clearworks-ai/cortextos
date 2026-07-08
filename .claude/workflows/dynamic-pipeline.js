export const meta = {
  name: 'dynamic-pipeline',
  description: 'Explore (parallel, read-only) -> plan (single, high-reasoning decompose) -> implement (parallel, worktree-isolated) -> merge -> review (loop) -> PR',
  whenToUse: 'A non-trivial coding task worth decomposing into non-conflicting workstreams and implementing in parallel with a high-effort review gate before opening a PR. Pass the task via args.',
  phases: [
    { title: 'Explore', detail: 'parallel read-only scans (default route: gemini)' },
    { title: 'Plan', detail: 'single plan stage; Fable only when args.confirmFable is explicit, otherwise Opus' },
    { title: 'Implement', detail: 'parallel codex-rescue workers with native worktree isolation (default model hint: gpt-5.4)' },
    { title: 'Merge', detail: 'single merge agent that runs git inside the subagent (default route: haiku)' },
    { title: 'Review', detail: 'single high-effort review loop; locked to Opus', model: 'opus' },
    { title: 'PR', detail: 'open a PR from the final candidate branch (default route: sonnet)' },
  ],
}

const A = args || {}
const task = A.task || 'NO TASK PROVIDED — pass args.task when invoking this workflow'
const repoPath = A.repoPath || '.'
const exploreCount = toPositiveInteger(A.exploreCount, 3)
const maxWorkstreams = toPositiveInteger(A.maxWorkstreams, 6)
const maxReviewLoops = toPositiveInteger(A.maxReviewLoops, 2)
const baseBranch = A.baseBranch || 'main'
const candidateBranch = A.candidateBranch || 'wf/candidate'

const DEFAULT_ROUTES = {
  explore: { model: 'haiku' },
  plan: {
    model: 'fable',
    agentType: 'fable-lean',
    effort: 'high',
    requiresConfirmation: true,
    fallback: 'opus',
  },
  implement: { model: 'gpt-5.4', agentType: 'codex-rescue' },
  merge: { model: 'haiku' },
  review: { model: 'opus', effort: 'high' },
  pr: { model: 'sonnet' },
  lessons: { model: 'sonnet' },
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isFableConfirmed() {
  return A.confirmFable === true || A.confirmFable === 'true' || A.confirmFable === 'yes'
}

function resolveStageRoute(stageName) {
  const baseRoute = DEFAULT_ROUTES[stageName]
  if (!baseRoute) {
    throw new Error(`Unknown stage "${stageName}"`)
  }

  const override =
    isRecord(A.routes) && isRecord(A.routes[stageName])
      ? A.routes[stageName]
      : null
  const route = override ? { ...baseRoute, ...override } : { ...baseRoute }

  if (stageName === 'review' && route.model !== 'opus') {
    throw new Error('Review stage must stay on model=opus')
  }

  if (stageName !== 'plan' && route.model === 'fable') {
    throw new Error('Fable is only allowed at the plan stage')
  }

  if (route.agentType === 'fable-lean' && stageName !== 'plan') {
    throw new Error('fable-lean is only allowed at the plan stage')
  }

  if (stageName === 'plan' && route.model === 'fable') {
    if (route.requiresConfirmation === false || isFableConfirmed()) {
      return route
    }

    return {
      model: route.fallback || 'opus',
      effort: route.effort,
      confirmationDeclined: true,
      fallback: route.fallback || 'opus',
    }
  }

  return route
}

function buildStageOptions(baseOpts, route, extra = {}) {
  const options = { ...baseOpts }

  if (route.agentType) {
    options.agentType = route.agentType
  }
  if (route.model && route.agentType !== 'codex-rescue') {
    options.model = route.model
  }
  if (route.effort) {
    options.effort = route.effort
  }
  if (extra.isolation) {
    options.isolation = extra.isolation
  }

  return options
}

function concatenate(items, separator) {
  let output = ''
  for (let index = 0; index < items.length; index++) {
    if (index > 0) output += separator
    output += String(items[index])
  }
  return output
}

async function executeStage(stageName, prompt, baseOpts, extra = {}) {
  const route = resolveStageRoute(stageName)
  return agent(prompt, buildStageOptions(baseOpts, route, extra))
}

function routeSummary(stageName) {
  const route = resolveStageRoute(stageName)
  const parts = []
  if (route.model) parts.push(`model=${route.model}`)
  if (route.agentType) parts.push(`agentType=${route.agentType}`)
  if (route.effort) parts.push(`effort=${route.effort}`)
  if (route.confirmationDeclined) parts.push(`fallback=${route.fallback || 'opus'}`)
  return concatenate(parts, ', ')
}

const EXPLORE_SCHEMA = {
  type: 'object',
  required: ['summary', 'relevantFiles'],
  properties: {
    summary: { type: 'string', description: 'What this area of the codebase does, relative to the task' },
    relevantFiles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'why'],
        properties: {
          path: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    conventions: { type: 'array', items: { type: 'string' }, description: 'Patterns or idioms to match' },
    risks: { type: 'array', items: { type: 'string' }, description: 'Gotchas, coupling, things that could break' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['approach', 'workstreams'],
  properties: {
    approach: { type: 'string', description: 'One-paragraph implementation strategy' },
    workstreams: {
      type: 'array',
      description: 'Independent chunks that do not touch the same files, so they can run in parallel',
      items: {
        type: 'object',
        required: ['id', 'title', 'instructions', 'files'],
        properties: {
          id: { type: 'string', description: 'short kebab id, e.g. "auth-mw"' },
          title: { type: 'string' },
          instructions: { type: 'string', description: 'Precise, self-contained build instructions for one agent' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files this workstream owns (must not overlap others)' },
          acceptance: { type: 'string', description: 'How to know this workstream is done' },
        },
      },
    },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['id', 'branch', 'committed', 'summary'],
  properties: {
    id: { type: 'string' },
    branch: { type: 'string', description: 'The branch this worktree committed to' },
    committed: { type: 'boolean', description: 'true if changes were committed to the branch' },
    summary: { type: 'string', description: 'What changed' },
    filesChanged: { type: 'array', items: { type: 'string' } },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  required: ['candidateBranch', 'mergedBranches', 'conflicts'],
  properties: {
    candidateBranch: { type: 'string' },
    mergedBranches: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'Branches or files that conflicted (empty = clean)' },
    buildPassed: { type: 'boolean' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['approved', 'problems'],
  properties: {
    approved: { type: 'boolean', description: 'true = ship it, no real problems' },
    problems: {
      type: 'array',
      description: 'Real correctness or design problems only. Each maps to the workstream that must fix it.',
      items: {
        type: 'object',
        required: ['workstreamId', 'issue', 'fix'],
        properties: {
          workstreamId: { type: 'string', description: 'id of the workstream that owns the fix' },
          issue: { type: 'string' },
          fix: { type: 'string', description: 'What the implement agent should change' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
      },
    },
  },
}

const PR_SCHEMA = {
  type: 'object',
  required: ['opened', 'url'],
  properties: {
    opened: { type: 'boolean' },
    url: { type: 'string' },
    title: { type: 'string' },
  },
}

log(
  `Routes -> explore(${routeSummary('explore')}), plan(${routeSummary('plan')}), ` +
    `implement(${routeSummary('implement')}), merge(${routeSummary('merge')}), ` +
    `review(${routeSummary('review')}), pr(${routeSummary('pr')}), lessons(${routeSummary('lessons')})`,
)

phase('Explore')
const reports = (await parallel(
  Array.from({ length: exploreCount }, (_, index) => () =>
    executeStage(
      'explore',
      `You are EXPLORER #${index + 1} of ${exploreCount}. READ-ONLY — do not edit anything.\n` +
        `Repo: ${repoPath}\n\n` +
        `TASK CONTEXT:\n${task}\n\n` +
        `Independently scan the codebase and report the context most relevant to this task: ` +
        `which files matter and why, the conventions or idioms to match, and the risks. ` +
        `You are one of ${exploreCount} independent explorers — do not assume the others found what you found; be thorough on your own.`,
      { label: `explore-${index + 1}`, phase: 'Explore', schema: EXPLORE_SCHEMA },
    ),
  ),
)).filter(Boolean)

log(`Explore complete: ${reports.length}/${exploreCount} reports`)

phase('Plan')
const plan = await executeStage(
  'plan',
  `You are the PLANNER. Read the ${reports.length} independent explore reports below and produce one ` +
    `implementation plan for this task, decomposed into independent workstreams.\n\n` +
    `TASK:\n${task}\n\n` +
    `EXPLORE REPORTS (JSON):\n${JSON.stringify(reports, null, 2)}\n\n` +
    `HARD REQUIREMENT: workstreams must be file-disjoint — no two workstreams may edit the same file — ` +
    `so they can be implemented in parallel worktrees without conflicting. ` +
    `Cap at ${maxWorkstreams} workstreams. Each workstream must be self-contained with precise instructions.`,
  { phase: 'Plan', schema: PLAN_SCHEMA },
)

let workstreams = plan.workstreams
  .slice(0, maxWorkstreams)
  .map((workstream) => ({ ...workstream, feedback: null }))
log(`Plan: ${workstreams.length} workstreams — ${concatenate(workstreams.map((workstream) => workstream.id), ', ')}`)

let review = null
let lastMerge = null

for (let loop = 1; loop <= maxReviewLoops; loop++) {
  const isFix = loop > 1
  log(`--- iteration ${loop}/${maxReviewLoops}${isFix ? ' (fix loop)' : ''} ---`)

  const toBuild = isFix ? workstreams.filter((workstream) => workstream.feedback) : workstreams
  const implementRoute = resolveStageRoute('implement')
  const impls = (await parallel(
    toBuild.map((workstream) => () => {
      const branch = `wf/ws-${workstream.id}`
      const baseRef = isFix ? candidateBranch : baseBranch
      const routeHint = implementRoute.model
        ? `Preferred implementation model hint: ${implementRoute.model}. `
        : ''
      const prompt =
        `You are the IMPLEMENTER for workstream "${workstream.id}" — ${workstream.title}.\n` +
        `Repo: ${repoPath}. You are running inside your own isolated worktree.\n\n` +
        `${routeHint}` +
        `Create or reset branch "${branch}" from "${baseRef}" inside this worktree before making changes.\n\n` +
        `INSTRUCTIONS:\n${workstream.instructions}\n\n` +
        `FILES YOU OWN (stay within these — do not touch other workstreams' files):\n${concatenate(workstream.files || [], '\n')}\n\n` +
        `ACCEPTANCE:\n${workstream.acceptance || 'Implements the instructions above and builds cleanly.'}\n\n` +
        (workstream.feedback
          ? `REVIEW FEEDBACK TO FIX (this is a fix loop — address exactly this):\n${workstream.feedback}\n\n`
          : '') +
        `When done, COMMIT your changes to branch "${branch}" with a clear message, then return the branch name. ` +
        `If you made no changes, return committed:false.`

      return executeStage(
        'implement',
        prompt,
        { label: `impl-${workstream.id}`, phase: 'Implement', schema: IMPL_SCHEMA },
        { isolation: 'worktree' },
      )
    }),
  )).filter(Boolean)

  const branches = impls.filter((result) => result.committed).map((result) => result.branch)
  log(`Implemented: ${branches.length} branch(es) — ${branches.length ? concatenate(branches, ', ') : '(none committed)'}`)

  lastMerge = await executeStage(
    'merge',
    `You are the MERGER. Run deterministic git only — do not edit code to resolve logic, only mechanical merges.\n` +
      `Repo: ${repoPath}.\n\n` +
      (isFix
        ? `The candidate branch "${candidateBranch}" already exists. Merge these fix branches into it: ${JSON.stringify(branches)}.\n`
        : `Create branch "${candidateBranch}" from "${baseBranch}", then merge these workstream branches into it in order: ${JSON.stringify(branches)}.\n`) +
      `Because workstreams were planned to be file-disjoint, merges should be clean. ` +
      `Report any conflicts (branch + files) rather than guessing a resolution. ` +
      `After merging, run the project build or typecheck if there is one and report whether it passed.`,
    { label: 'merge', phase: 'Merge', schema: MERGE_SCHEMA },
  )
  log(
    `Merge -> ${lastMerge.candidateBranch}; conflicts: ` +
      `${lastMerge.conflicts.length ? concatenate(lastMerge.conflicts, ', ') : 'none'}; ` +
      `build: ${lastMerge.buildPassed ? 'pass' : 'unknown/fail'}`,
  )

  review = await executeStage(
    'review',
    `You are the REVIEWER. High-effort review of the merged candidate branch "${candidateBranch}" vs "${baseBranch}".\n` +
      `Repo: ${repoPath}.\n\n` +
      `ORIGINAL TASK:\n${task}\n\n` +
      `Read the full merged diff (for example: git diff ${baseBranch}...${candidateBranch}). ` +
      `Flag only real correctness or design problems — not nits. For each problem, name the workstream id that owns the fix ` +
      `(valid ids: ${concatenate(workstreams.map((workstream) => workstream.id), ', ')}) so it can be routed back to Implement. ` +
      `If there are no real problems, set approved:true.`,
    { label: 'review', phase: 'Review', schema: REVIEW_SCHEMA },
  )

  if (review.approved || review.problems.length === 0) {
    log(`Review APPROVED on iteration ${loop}`)
    break
  }

  if (loop === maxReviewLoops) {
    log(
      `Review still found ${review.problems.length} problem(s) after ` +
        `${maxReviewLoops} iterations — stopping loop, PR will note this`,
    )
    break
  }

  const problemsByWorkstream = {}
  for (const problem of review.problems) {
    const entry = `[${problem.severity || 'issue'}] ${problem.issue}\n  FIX: ${problem.fix}`
    if (problemsByWorkstream[problem.workstreamId]) {
      problemsByWorkstream[problem.workstreamId].push(entry)
    } else {
      problemsByWorkstream[problem.workstreamId] = [entry]
    }
  }

  workstreams = workstreams.map((workstream) => ({
    ...workstream,
    feedback: problemsByWorkstream[workstream.id]
      ? concatenate(problemsByWorkstream[workstream.id], '\n')
      : null,
  }))
  log(`Looping back to Implement for: ${concatenate(Object.keys(problemsByWorkstream), ', ')}`)
}

phase('PR')
const unresolved = review && !review.approved ? review.problems : []
const pr = await executeStage(
  'pr',
  `You are the PR agent. Open a pull request from "${candidateBranch}" into "${baseBranch}" using gh pr create.\n` +
    `Repo: ${repoPath}.\n\n` +
    `TASK:\n${task}\n\n` +
    `PLAN SUMMARY:\n${plan.approach}\n\n` +
    `Write a clear title and a body summarizing the workstreams ` +
    `(${concatenate(workstreams.map((workstream) => workstream.id), ', ')}) and what changed.\n` +
    (unresolved.length
      ? `NOTE IN THE PR BODY: ${unresolved.length} review problem(s) remained unresolved after ${maxReviewLoops} iterations:\n` +
        unresolved
          .map((problem) => `- [${problem.severity || 'issue'}] (${problem.workstreamId}) ${problem.issue}`)
          .reduce((output, line, index) => output + (index > 0 ? '\n' : '') + line, '') +
        '\n'
      : 'The reviewer approved the merged diff.\n') +
    'Do NOT merge the PR — just open it and return the URL.',
  { label: 'open-pr', phase: 'PR', schema: PR_SCHEMA },
)

phase('Lessons')
const lessons = await executeStage(
  'lessons',
  `You are the LESSONS agent. Reflect on this pipeline run for task:\n${task}\n\n` +
    `Review outcome: ${JSON.stringify(review)}\nMerge: ${JSON.stringify(lastMerge)}\n\n` +
    `If (and only if) this run produced a non-obvious, reusable lesson — a failure and its fix, a gotcha, or a durable standard worth remembering — write one lesson per file to ` +
    `/Users/joshweiss/code/knowledge-sync/lessons/<kebab-slug>.md. Each file: a title, a dated Context, the Lesson, and How-to-apply — short and genuinely reusable. ` +
    `Do NOT write filler or restate the task; if there is no real lesson, write nothing. Return the list of lesson file paths written (empty if none).`,
  {
    label: 'lessons',
    phase: 'Lessons',
    schema: {
      type: 'object',
      required: ['lessonFiles'],
      properties: {
        lessonFiles: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

return {
  task,
  workstreams: workstreams.map((workstream) => ({ id: workstream.id, title: workstream.title })),
  merge: lastMerge,
  review,
  pr,
  lessons,
}
