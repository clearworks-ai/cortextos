import { recordEventRoutingReceipt, type EventReceipt } from './event-delivery.js';

export type RouterMode = 'off' | 'shadow' | 'active';

export interface ProposedRoute {
  eventId: string;
  target: string;
  reason?: string;
}

export interface ShadowRouterOptions {
  /** Receipt domain owned by this module; required for shadow and active modes. */
  stateDir?: string;
  /** Active-only transport capability. It is never available to shadow mode. */
  deliver?: (route: ProposedRoute) => void;
}

export interface RouteResult {
  mode: RouterMode;
  proposed: boolean;
  delivered: boolean;
}

function assertSafeRouteValue(value: string | undefined): void {
  if (value !== undefined && !/^[a-z][a-z0-9_.:-]{0,95}$/.test(value)) throw new Error('invalid route');
}

/**
 * The receipt writer is module-owned: callers cannot forge a no-op recorder
 * with transport behavior. Shadow mode only appends a proposed-route receipt.
 */
export class ShadowRouter {
  private readonly stateDir?: string;
  private readonly deliver?: (route: ProposedRoute) => void;

  constructor(private readonly mode: RouterMode, options: ShadowRouterOptions = {}) {
    if (mode !== 'off' && !options.stateDir) throw new Error('router requires a durable receipt state directory');
    if (mode === 'shadow' && options.deliver) throw new Error('shadow router cannot accept a delivery capability');
    this.stateDir = options.stateDir;
    this.deliver = options.deliver;
    if (mode === 'active' && !this.deliver) throw new Error('active router requires delivery capability');
  }

  route(receipt: EventReceipt, target: string, reason?: string): RouteResult {
    assertSafeRouteValue(target);
    assertSafeRouteValue(reason);
    if (this.mode === 'off') return { mode: 'off', proposed: false, delivered: false };
    const route: ProposedRoute = { eventId: receipt.event_id, target, reason };
    if (this.mode === 'shadow') {
      recordEventRoutingReceipt(this.stateDir as string, route.eventId, 'proposed', route.target, route.reason);
      return { mode: 'shadow', proposed: true, delivered: false };
    }
    // Receipt write is intentionally before the injected transport call.
    recordEventRoutingReceipt(this.stateDir as string, route.eventId, 'attempted', route.target, route.reason);
    try {
      (this.deliver as (route: ProposedRoute) => void)(route);
    } catch (error) {
      recordEventRoutingReceipt(this.stateDir as string, route.eventId, 'failed', route.target, 'delivery_failed');
      throw error;
    }
    return { mode: 'active', proposed: true, delivered: true };
  }
}
