import type { Brand, Db } from '../db/types.js';
import type { EngineName } from './engines.js';

export interface ScheduledRefreshTarget {
  brand: Brand;
  engines: EngineName[];
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
