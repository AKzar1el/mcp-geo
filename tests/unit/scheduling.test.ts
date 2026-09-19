import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getScheduledRefreshTargets } from '../../src/core/scheduling.ts';
import type { Brand, Db } from '../../src/db/types.ts';

function brand(id: string): Brand {
  return {
    id,
    user_id: 'user',
    domain: `${id}.example`,
    name: id,
    category: null,
    competitors: [],
    aliases: [],
    exclude_terms: [],
    refresh_frequency: 'weekly',
    created_at: 0,
    updated_at: 0,
  };
}

test('scheduled refresh targets include only the engines that are actually due', async () => {
  const mixed = brand('mixed');
  const claudeOnly = brand('claude-only');
  const calls: string[][] = [];
  const db: Pick<Db, 'getBrandsDueForRefresh'> = {
    async getBrandsDueForRefresh(engines = []) {
      calls.push(engines);
      if (engines[0] === 'chatgpt') return [mixed];
      if (engines[0] === 'claude') return [mixed, claudeOnly];
      return [];
    },
  };

  const targets = await getScheduledRefreshTargets(db, [
    'chatgpt',
    'claude',
    'chatgpt',
  ]);

  assert.deepEqual(calls, [['chatgpt'], ['claude']]);
  assert.deepEqual(
    targets.map((target) => ({
      brand_id: target.brand.id,
      engines: target.engines,
    })),
    [
      { brand_id: 'mixed', engines: ['chatgpt', 'claude'] },
      { brand_id: 'claude-only', engines: ['claude'] },
    ],
  );
});
