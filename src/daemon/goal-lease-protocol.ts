import { randomUUID } from 'node:crypto';
import type { GoalRun } from '../types/goal-run.js';
export class GoalLeaseProtocol {
  private static readonly DEFAULT_LEASE_TTL_MS = 5 * 60_000; private static readonly LEASE_GRACE_MS = 30_000;
  static generateLease(owner: string) { return { leaseOwner: owner, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + this.DEFAULT_LEASE_TTL_MS).toISOString() }; }
  static isValid(run: GoalRun, token: string): boolean { return Boolean(run.leaseToken && run.leaseToken === token && run.leaseExpiresAt && Date.now() < new Date(run.leaseExpiresAt).getTime() + this.LEASE_GRACE_MS); }
  static isExpired(run: GoalRun): boolean { return !run.leaseExpiresAt || Date.now() >= new Date(run.leaseExpiresAt).getTime(); }
  static renew(run: GoalRun): GoalRun { if (!run.leaseOwner || !run.leaseToken) throw new Error('Cannot renew lease: no active lease'); if (this.isExpired(run)) throw new Error('Cannot renew expired lease'); return { ...run, leaseExpiresAt: new Date(Date.now() + this.DEFAULT_LEASE_TTL_MS).toISOString(), updatedAt: new Date().toISOString() }; }
  static clear(run: GoalRun): GoalRun { const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expiry, ...rest } = run; return { ...rest, updatedAt: new Date().toISOString() }; }
}
