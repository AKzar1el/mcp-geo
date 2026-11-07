import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getScheduledRefreshTargets,
  planScheduledDispatch,
  MAX_SCHEDULED_SERVICE_INVOCATIONS,
} from '../../src/core/scheduling.ts';
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

test('cron dispatch stays below the service binding invocation limit', () => {
  const targets = Array.from({ length: 17 }, (_, i) => ({
    brand: brand(`brand-${String(i).padStart(2, '0')}`),
    engines: ['chatgpt', 'claude', 'gemini'] as const,
  }));
  const plan = planScheduledDispatch(
    targets.map((target) => ({ ...target, engines: [...target.engines] })),
    0,
  );
  assert.equal(MAX_SCHEDULED_SERVICE_INVOCATIONS, 28);
  assert.equal(plan.requestedInvocations, 51);
  assert.equal(plan.scheduledInvocations, 28);
  assert.equal(plan.deferredInvocations, 23);
  assert.equal(plan.targets.reduce((sum, target) => sum + target.engines.length, 0), 28);
  assert.equal(new Set(plan.targets.map((target) => target.brand.id)).size, plan.targets.length);
});

test('deferred brands eventually receive a slot even when the due set stays unchanged', () => {
  const targets = Array.from({ length: 41 }, (_, i) => ({
    brand: brand(`brand-${String(i).padStart(2, '0')}`),
    engines: ['chatgpt'] as const,
  }));
  const seen = new Set<string>();
  for (let slot = 0; slot < targets.length; slot++) {
    const plan = planScheduledDispatch(
      targets.map((target) => ({ ...target, engines: [...target.engines] })),
      slot * 6 * 60 * 60 * 1000,
      7,
    );
    assert.equal(plan.scheduledInvocations, 7);
    for (const target of plan.targets) seen.add(target.brand.id);
  }
  assert.equal(seen.size, targets.length);
});

test('partially selected brands rotate their due engines across cron windows', () => {
  const targets = [{
    brand: brand('many-engines'),
    engines: ['chatgpt', 'claude', 'gemini', 'grok', 'perplexity'] as const,
  }];
  const seen = new Set<string>();
  for (let slot = 0; slot < 5; slot++) {
    const plan = planScheduledDispatch(
      targets.map((target) => ({ ...target, engines: [...target.engines] })),
      slot * 6 * 60 * 60 * 1000,
      2,
    );
    assert.equal(plan.scheduledInvocations, 2);
    for (const target of plan.targets) {
      for (const engine of target.engines) seen.add(engine);
    }
  }
  assert.deepEqual([...seen].sort(), [...targets[0].engines].sort());
});

test('cron does not starve engines when brand and engine rotations share a period', () => {
  const engines = ['chatgpt', 'claude', 'gemini', 'perplexity'] as const;
  const targets = ['a', 'b'].map((id) => ({ brand: brand(id), engines: [...engines] }));
  const observed = new Map<string, Set<string>>();

  for (let slot = 0; slot < 8; slot++) {
    const plan = planScheduledDispatch(targets, slot * 6 * 60 * 60 * 1000, 1);
    assert.equal(plan.scheduledInvocations, 1);
    for (const target of plan.targets) {
      const seen = observed.get(target.brand.id) ?? new Set<string>();
      for (const engine of target.engines) seen.add(engine);
      observed.set(target.brand.id, seen);
    }
  }

  for (const id of ['a', 'b']) {
    assert.deepEqual([...observed.get(id) ?? []].sort(), [...engines].sort(), id);
  }
});

test('an empty due set dispatches nothing', () => {
  assert.deepEqual(planScheduledDispatch([], 0), {
    targets: [], requestedInvocations: 0, scheduledInvocations: 0, deferredInvocations: 0,
  });
});
