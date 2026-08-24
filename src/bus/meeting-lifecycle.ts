export class LifecycleProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleProjectionError';
  }
}

export interface LifecycleBuckets {
  myTasks: string[];
  waitingOnThem: string[];
  completedClosed: string[];
  notTasks: string[];
}

interface WorkClaim {
  canonicalClaimId: string;
  semanticClass: string;
  direction: string;
  workState: string;
  ownerId: unknown;
  materialization: { task?: unknown };
  dependency: { kind?: unknown; ownerId?: unknown; satisfied?: unknown };
  disposition: { state?: unknown };
}

function asClaim(value: unknown, index: number): WorkClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LifecycleProjectionError(`claims[${index}] must be an object`);
  }
  const claim = value as Record<string, unknown>;
  const materialization = claim.materialization && typeof claim.materialization === 'object'
    ? claim.materialization as Record<string, unknown>
    : {};
  const dependency = claim.dependency && typeof claim.dependency === 'object'
    ? claim.dependency as Record<string, unknown>
    : {};
  const disposition = claim.disposition && typeof claim.disposition === 'object'
    ? claim.disposition as Record<string, unknown>
    : {};
  if (typeof claim.canonicalClaimId !== 'string' || claim.canonicalClaimId.length < 1) {
    throw new LifecycleProjectionError(`claims[${index}].canonicalClaimId is required`);
  }
  return {
    canonicalClaimId: claim.canonicalClaimId,
    semanticClass: String(claim.semanticClass ?? ''),
    direction: String(claim.direction ?? ''),
    workState: String(claim.workState ?? ''),
    ownerId: claim.ownerId,
    materialization,
    dependency,
    disposition,
  };
}

export function projectLifecycleBuckets(record: {
  claims: unknown[];
  lifecycle?: LifecycleBuckets;
}): LifecycleBuckets {
  const myTasks: string[] = [];
  const waitingOnThem: string[] = [];
  const completedClosed: string[] = [];
  const notTasks: string[] = [];

  record.claims.map(asClaim).forEach((claim) => {
    if (claim.semanticClass !== 'work_item' || claim.disposition.state !== 'accepted') return;
    if (
      ['josh_owned', 'shared'].includes(claim.direction)
      && ['open', 'contingent'].includes(claim.workState)
      && claim.materialization.task === true
    ) {
      myTasks.push(claim.canonicalClaimId);
      return;
    }
    if (
      claim.direction === 'external_owned'
      && claim.workState === 'waiting'
      && claim.materialization.task === true
      && claim.dependency.kind !== 'none'
      && claim.dependency.ownerId === claim.ownerId
      && claim.dependency.satisfied === false
    ) {
      waitingOnThem.push(claim.canonicalClaimId);
      return;
    }
    if (['completed', 'closed_abandoned'].includes(claim.workState)) {
      completedClosed.push(claim.canonicalClaimId);
      return;
    }
    if (claim.workState === 'not_a_task' && claim.materialization.task === false) {
      notTasks.push(claim.canonicalClaimId);
      return;
    }
    throw new LifecycleProjectionError(`unprojectable work item ${claim.canonicalClaimId}`);
  });

  return { myTasks, waitingOnThem, completedClosed, notTasks };
}
