import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleAdminUpdateBrand } from '../../src/core/admin-prompt-set.ts';
import { updateTrackedBrand } from '../../src/core/update-brand.ts';
import { openSqliteDb } from '../../src/db/sqlite.ts';

async function seededDb() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-geo-brand-update-'));
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  await db.upsertUser('test-user', 'test@local');
  await db.createBrand({
    id: 'acme',
    user_id: 'test-user',
    name: 'Acme',
    domain: 'acme.com',
    category: 'Project management',
    competitors: ['asana.com', 'monday.com'],
    aliases: ['Acme PM'],
    exclude_terms: [],
    refresh_frequency: 'weekly',
  });
  await db.replacePrompts('acme', [
    { text: 'best project management tools', intent_stage: 'awareness', shape: 'best X' },
    { text: 'acme vs asana', intent_stage: 'comparison', shape: 'X vs Y' },
  ]);
  return { root, db };
}

test('updateTrackedBrand updates mutable metadata and preserves active prompts', async () => {
  const { root, db } = await seededDb();
  try {
    const beforePrompts = await db.getActivePrompts('acme');
    const result = await updateTrackedBrand(db, {
      brand_id: 'acme',
      name: 'Acme Suite',
      domain: 'https://www.New-Acme.com/pricing',
      category: null,
      competitors: ['asana.com', 'new-acme.com', 'Asana.com'],
      aliases: ['Acme Suite', ' acme suite ', 'AS'],
      exclude_terms: ['acme'],
      refresh_frequency: 'daily',
    });

    assert.equal(result.updated, true);
    assert.equal(result.prompt_set_review_recommended, true);
    assert.equal(result.historical_attribution_review_recommended, true);
    assert.deepEqual(result.changed_fields, [
      'name',
      'domain',
      'category',
      'competitors',
      'aliases',
      'exclude_terms',
      'refresh_frequency',
    ]);
    assert.equal(result.brand.name, 'Acme Suite');
    assert.equal(result.brand.domain, 'new-acme.com');
    assert.equal(result.brand.category, null);
    assert.deepEqual(result.brand.competitors, ['asana.com']);
    assert.deepEqual(result.brand.aliases, ['Acme Suite', 'AS']);
    assert.deepEqual(result.brand.exclude_terms, ['acme']);
    assert.equal(result.brand.refresh_frequency, 'daily');
    assert.ok(typeof result.brand.identity_changed_at === 'number');
    const identityBoundary = result.brand.identity_changed_at;

    const afterPrompts = await db.getActivePrompts('acme');
    assert.deepEqual(
      afterPrompts.map((prompt) => [prompt.id, prompt.text]),
      beforePrompts.map((prompt) => [prompt.id, prompt.text]),
    );

    const paused = await updateTrackedBrand(db, {
      brand_id: 'acme',
      refresh_frequency: 'manual',
    });
    assert.equal(paused.updated, true);
    assert.equal(paused.prompt_set_review_recommended, false);
    assert.equal(paused.historical_attribution_review_recommended, false);
    assert.deepEqual(paused.changed_fields, ['refresh_frequency']);
    assert.equal(paused.brand.refresh_frequency, 'manual');
    assert.equal(paused.brand.identity_changed_at, identityBoundary);
    assert.deepEqual(
      (await db.getActivePrompts('acme')).map((prompt) => [prompt.id, prompt.text]),
      beforePrompts.map((prompt) => [prompt.id, prompt.text]),
    );

    const noOp = await updateTrackedBrand(db, {
      brand_id: 'acme',
      name: 'Acme Suite',
      domain: 'new-acme.com',
      category: null,
      competitors: ['asana.com'],
      aliases: ['Acme Suite', 'AS'],
      exclude_terms: ['acme'],
      refresh_frequency: 'manual',
    });
    assert.equal(noOp.updated, false);
    assert.equal(noOp.prompt_set_review_recommended, false);
    assert.equal(noOp.historical_attribution_review_recommended, false);
    assert.deepEqual(noOp.changed_fields, []);
    assert.equal(noOp.brand.identity_changed_at, identityBoundary);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity-only edits flag historical comparability, while competitor-only edits do not', async () => {
  const { root, db } = await seededDb();
  try {
    const identity = await updateTrackedBrand(db, { brand_id: 'acme', domain: 'new-acme.com' });
    assert.equal(identity.prompt_set_review_recommended, false);
    assert.equal(identity.historical_attribution_review_recommended, true);
    assert.ok(typeof identity.brand.identity_changed_at === 'number');
    const competitors = await updateTrackedBrand(db, { brand_id: 'acme', competitors: ['linear.app'] });
    assert.equal(competitors.historical_attribution_review_recommended, false);
    assert.equal(competitors.brand.identity_changed_at, identity.brand.identity_changed_at);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reordering unchanged brand term sets does not invalidate historical attribution', async () => {
  const { root, db } = await seededDb();
  try {
    const seeded = await updateTrackedBrand(db, {
      brand_id: 'acme',
      aliases: ['Acme PM', 'Acme Suite'],
      exclude_terms: ['acme', 'demo'],
    });
    const promptsBefore = await db.getActivePrompts('acme');
    const reordered = await updateTrackedBrand(db, {
      brand_id: 'acme',
      competitors: ['monday.com', 'asana.com'],
      aliases: ['Acme Suite', 'Acme PM'],
      exclude_terms: ['demo', 'acme'],
    });

    assert.equal(reordered.updated, false);
    assert.deepEqual(reordered.changed_fields, []);
    assert.equal(reordered.historical_attribution_review_recommended, false);
    assert.equal(reordered.prompt_set_review_recommended, false);
    assert.equal(reordered.brand.updated_at, seeded.brand.updated_at);
    assert.equal(reordered.brand.identity_changed_at, seeded.brand.identity_changed_at);
    assert.deepEqual(reordered.brand.competitors, ['asana.com', 'monday.com']);
    assert.deepEqual(reordered.brand.aliases, ['Acme PM', 'Acme Suite']);
    assert.deepEqual(reordered.brand.exclude_terms, ['acme', 'demo']);
    assert.deepEqual(await db.getActivePrompts('acme'), promptsBefore);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('case-only brand name, alias and exclusion edits retain the existing identity boundary', async () => {
  const { root, db } = await seededDb();
  try {
    const seeded = await updateTrackedBrand(db, {
      brand_id: 'acme',
      exclude_terms: ['Acme'],
    });
    const identityBoundary = seeded.brand.identity_changed_at;
    assert.ok(typeof identityBoundary === 'number');

    const caseOnly = await updateTrackedBrand(db, {
      brand_id: 'acme',
      name: 'ACME',
      aliases: ['ACME pm'],
      exclude_terms: ['ACME'],
    });
    assert.equal(caseOnly.updated, true, 'display capitalization can still be updated');
    assert.deepEqual(caseOnly.changed_fields, ['name', 'aliases', 'exclude_terms']);
    assert.equal(caseOnly.historical_attribution_review_recommended, false);
    assert.equal(caseOnly.brand.identity_changed_at, identityBoundary);
    assert.equal(caseOnly.brand.name, 'ACME');
    assert.deepEqual(caseOnly.brand.aliases, ['ACME pm']);
    assert.deepEqual(caseOnly.brand.exclude_terms, ['ACME']);

    const renamedAlias = await updateTrackedBrand(db, {
      brand_id: 'acme', aliases: ['Different Brand'],
    });
    assert.equal(renamedAlias.historical_attribution_review_recommended, true,
      'a changed matching term still invalidates historical identity attribution');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('updateTrackedBrand rejects malformed input and missing brands without mutation', async () => {
  const { root, db } = await seededDb();
  try {
    await assert.rejects(
      updateTrackedBrand(db, { brand_id: 'missing', name: 'Missing' }),
      /brand not found/,
    );
    await assert.rejects(
      updateTrackedBrand(db, { brand_id: 'acme', domain: 'not a domain' }),
      /does not look like a domain/,
    );
    const brand = await db.getBrand('acme');
    assert.equal(brand?.domain, 'acme.com');
    assert.equal(brand?.name, 'Acme');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('admin update-brand exposes the same safe partial update contract', async () => {
  const { root, db } = await seededDb();
  try {
    const response = await handleAdminUpdateBrand(
      new Request('https://example.test/admin/update-brand', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          brand_id: 'acme',
          category: 'CRM software',
          competitors: ['linear.app'],
          aliases: ['Acme PM', 'Acme Cloud'],
          refresh_frequency: 'manual',
        }),
      }),
      db,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      updated: boolean;
      changed_fields: string[];
      prompt_set_review_recommended: boolean;
      brand: {
        competitors: string[];
        aliases: string[];
        refresh_frequency: string;
      };
      next_steps: string;
    };
    assert.equal(body.updated, true);
    assert.equal(body.prompt_set_review_recommended, true);
    assert.equal((body as typeof body & { historical_attribution_review_recommended: boolean }).historical_attribution_review_recommended, true);
    assert.deepEqual(body.changed_fields, [
      'category',
      'competitors',
      'aliases',
      'refresh_frequency',
    ]);
    assert.deepEqual(body.brand.competitors, ['linear.app']);
    assert.deepEqual(body.brand.aliases, ['Acme PM', 'Acme Cloud']);
    assert.equal(body.brand.refresh_frequency, 'manual');
    assert.match(body.next_steps, /historical runs were preserved/);
    assert.match(body.next_steps, /admin\/set-prompts/);
    assert.match(body.next_steps, /not directly comparable/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hosted update-brand rejects out-of-bounds metadata before database access', async () => {
  let reads = 0;
  const db = {
    getBrand: async () => {
      reads += 1;
      return null;
    },
  } as unknown as Parameters<typeof updateTrackedBrand>[0];
  const invalid: Array<[string, Record<string, unknown>, RegExp]> = [
    ['name', { name: 'n'.repeat(201) }, /name.*200/i],
    ['domain', { domain: 'd'.repeat(254) }, /domain.*253/i],
    ['category', { category: 'c'.repeat(201) }, /category.*200/i],
    ['competitor count', { competitors: Array(21).fill('example.com') }, /competitors.*20/i],
    ['competitor length', { competitors: ['x'.repeat(254)] }, /competitors.*253/i],
    ['empty competitor', { competitors: [''] }, /competitors.*3/i],
    ['alias count', { aliases: Array(21).fill('Alias') }, /aliases.*20/i],
    ['alias length', { aliases: ['a'.repeat(101)] }, /aliases.*100/i],
    ['empty alias', { aliases: [''] }, /aliases.*1/i],
    ['exclude count', { exclude_terms: Array(21).fill('ignore') }, /exclude_terms.*20/i],
    ['exclude length', { exclude_terms: ['e'.repeat(101)] }, /exclude_terms.*100/i],
  ];
  for (const [label, fields, expectedError] of invalid) {
    const response = await handleAdminUpdateBrand(
      new Request('https://example.test/admin/update-brand', {
        method: 'POST',
        body: JSON.stringify({ brand_id: 'acme', ...fields }),
      }),
      db,
    );
    assert.equal(response.status, 400, label);
    assert.match((await response.json() as { error: string }).error, expectedError, label);
  }
  assert.equal(reads, 0, 'invalid metadata must not trigger database reads');
});
