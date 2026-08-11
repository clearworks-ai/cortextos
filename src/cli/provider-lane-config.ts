import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { RouterMode } from '../bus/shadow-router.js';

/**
 * Per-lane routing mode (FR-E2). A provider event lane (gmail, calendar, ...)
 * runs in `shadow` — routing proposals are recorded but nothing is delivered —
 * until it is DELIBERATELY flipped to `active`. `off` disables routing entirely.
 *
 * SAFETY INVARIANT: the default for EVERY lane is `shadow`. A lane never goes
 * active by omission — activation (FR-E3) is a separate, receipted flip that
 * must also wire a delivery capability. This module is the read path only; it
 * never returns `active` for a lane absent from config.
 */
export type LaneMode = RouterMode;

/** Canonical lane keys used in provider-config.json. */
export type ProviderLane = 'gmail' | 'calendar';

const VALID_MODES: ReadonlySet<string> = new Set<LaneMode>(['off', 'shadow', 'active']);

/** The safe default applied to any lane not explicitly configured. */
export const DEFAULT_LANE_MODE: LaneMode = 'shadow';

/** Filename of the per-lane provider config, read from the provided config dir. */
export const PROVIDER_CONFIG_FILENAME = 'provider-config.json';

interface ProviderConfigFile {
  lanes?: Record<string, unknown>;
}

/**
 * Resolve a single lane's mode from a parsed config object, defaulting to
 * `shadow`. Any malformed / unknown value collapses to the safe default — a
 * corrupt config can never silently activate a lane.
 */
export function resolveLaneModeFrom(config: ProviderConfigFile | undefined, lane: ProviderLane): LaneMode {
  const lanes = config?.lanes;
  if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) return DEFAULT_LANE_MODE;
  const raw = (lanes as Record<string, unknown>)[lane];
  if (typeof raw !== 'string') return DEFAULT_LANE_MODE;
  const entry = raw.trim().toLowerCase();
  return VALID_MODES.has(entry) ? (entry as LaneMode) : DEFAULT_LANE_MODE;
}

/**
 * Read provider-config.json from `configDir` and return its parsed shape, or
 * undefined when the file is absent or unparseable. A missing/invalid file is
 * not an error: every lane then resolves to the `shadow` default.
 */
export function readProviderConfig(configDir: string): ProviderConfigFile | undefined {
  const path = join(configDir, PROVIDER_CONFIG_FILENAME);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as ProviderConfigFile;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a lane's mode from provider-config.json under `configDir`. Defaults to
 * `shadow` when the file is missing, malformed, or omits the lane — so no lane
 * goes active without a deliberate, well-formed config entry.
 */
export function resolveLaneMode(configDir: string, lane: ProviderLane): LaneMode {
  return resolveLaneModeFrom(readProviderConfig(configDir), lane);
}
