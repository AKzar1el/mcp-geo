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

    const afterPrompts = await db.getActivePrompts('acme');
    assert.deepEqual(
      afterPrompts.map((prompt) => [prompt.id, prompt.text]),
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
      refresh_frequency: 'daily',
    });
    assert.equal(noOp.updated, false);
    assert.deepEqual(noOp.changed_fields, []);
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
          competitors: ['linear.app'],
          aliases: ['Acme PM', 'Acme Cloud'],
        }),
      }),
      db,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      updated: boolean;
      changed_fields: string[];
      brand: { competitors: string[]; aliases: string[] };
      next_steps: string;
    };
    assert.equal(body.updated, true);
    assert.deepEqual(body.changed_fields, ['competitors', 'aliases']);
    assert.deepEqual(body.brand.competitors, ['linear.app']);
    assert.deepEqual(body.brand.aliases, ['Acme PM', 'Acme Cloud']);
    assert.match(body.next_steps, /historical runs were preserved/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
