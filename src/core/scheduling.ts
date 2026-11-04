import type { Brand, Db } from '../db/types.js';
import type { EngineName } from './engines.js';

export interface ScheduledRefreshTarget {
  brand: Brand;
  engines: EngineName[];
}

// The platform allows at most 32 Worker invocations from one request.
// Leave headroom for other service binding calls added to the cron path.
export const MAX_SCHEDULED_SERVICE_INVOCATIONS = 28;
const CRON_WINDOW_MS = 6 * 60 * 60 * 1000; // wrangler.jsonc: 0 */6 * * *

export interface ScheduledDispatchPlan {
  targets: ScheduledRefreshTarget[];
  requestedInvocations: number;
  scheduledInvocations: number;
  deferredInvocations: number;
}

function gcd(a: number, b: number): number {
  while (b > 0) [a, b] = [b, a % b];
  return a;
}

// Prefer a near-budget hop, but choose one coprime to the number of brands
// so that a permanently failing brand cannot pin cron to the same subset.
function rotationStride(brandCount: number, budget: number): number {
  for (let step = Math.min(brandCount - 1, budget - 1); step > 0; step--) {
    if (gcd(step, brandCount) === 1) return step;
  }
  return 1;
}

// Count *engine* dispatches, not brands: runEngines makes one SELF.fetch per
// engine. Selection is deterministic for a cron window and rotates on later
// windows. Deferred engines remain due and are reconsidered next cron.
export function planScheduledDispatch(
  targets: ScheduledRefreshTarget[],
  scheduledTime: number,
  maxInvocations = MAX_SCHEDULED_SERVICE_INVOCATIONS,
): ScheduledDispatchPlan {
  if (!Number.isFinite(scheduledTime) || scheduledTime < 0) {
    throw new Error('Invalid scheduled time');
  }
  if (!Number.isInteger(maxInvocations) || maxInvocations < 1 || maxInvocations > 32) {
    throw new Error('Invalid scheduled service binding budget');
  }
  const requestedInvocations = targets.reduce((sum, target) => sum + target.engines.length, 0);
  if (targets.length === 0 || requestedInvocations === 0) {
    return { targets: [], requestedInvocations, scheduledInvocations: 0, deferredInvocations: 0 };
  }

  const ordered = [...targets].sort((a, b) =>
    a.brand.id < b.brand.id ? -1 : a.brand.id > b.brand.id ? 1 : 0);
  const slot = Math.floor(scheduledTime / CRON_WINDOW_MS);
  const offset = ((slot % ordered.length) * rotationStride(ordered.length, maxInvocations))
    % ordered.length;
  const selected: ScheduledRefreshTarget[] = [];
  let remaining = maxInvocations;

  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    const target = ordered[(offset + i) % ordered.length];
    const take = Math.min(target.engines.length, remaining);
    if (take === 0) continue;
    // Partial brand selections also rotate engine order to avoid starving a
    // later engine when the last budget slot always lands on this brand.
    const engineOffset = take < target.engines.length ? slot % target.engines.length : 0;
    const engines = Array.from({ length: take }, (_, j) =>
      target.engines[(engineOffset + j) % target.engines.length]);
    selected.push({ brand: target.brand, engines });
    remaining -= take;
  }

  const scheduledInvocations = maxInvocations - remaining;
  return {
    targets: selected,
    requestedInvocations,
    scheduledInvocations,
    deferredInvocations: requestedInvocations - scheduledInvocations,
  };
}

// A brand can be due because only one configured engine is stale. Build the
// plan per engine so cron does not unnecessarily re-run already-fresh engines.
export async function getScheduledRefreshTargets(
  db: Pick<Db, 'getBrandsDueForRefresh'>,
  engines: EngineName[],
): Promise<ScheduledRefreshTarget[]> {
  const targets = new Map<string, ScheduledRefreshTarget>();

  for (const engine of [...new Set(engines)]) {
    const brandsDue = await db.getBrandsDueForRefresh([engine]);
    for (const brand of brandsDue) {
      const existing = targets.get(brand.id);
      if (existing) {
        existing.engines.push(engine);
      } else {
        targets.set(brand.id, { brand, engines: [engine] });
      }
    }
  }

  return [...targets.values()];
}
