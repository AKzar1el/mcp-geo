import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runLocalRefresh } from '../../src/core/local-refresh.ts';
import { openSqliteDb } from '../../src/db/sqlite.ts';
import type { Prompt } from '../../src/db/types.ts';

test('overlapping CLI refreshes share a live reservation and do not run duplicate paid engine calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-geo-cli-singleflight-'));
  const db = openSqliteDb(join(root, 'test.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@example.test');
    await db.createBrand({
      id: 'singleflight', user_id: 'test-user', name: 'Acme', domain: 'acme.com',
      category: null, competitors: [], aliases: [], exclude_terms: [],
      refresh_frequency: 'manual',
    });
    const brand = await db.getBrand('singleflight');
    assert.ok(brand);
    const prompts: Prompt[] = [{
      id: 'prompt-1', brand_id: brand.id, text: 'Best products in this category?',
      intent_stage: null, shape: null, active: 1, created_at: 0,
    }];

    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    let executed = 0;
    const first = runLocalRefresh(db, {}, brand, prompts, ['chatgpt', 'chatgpt'], async () => {
      executed++;
      signalStarted();
      await gate;
    });
    let second;
    try {
      await started;
      second = await runLocalRefresh(db, {}, brand, prompts, ['chatgpt'], async () => {
        executed++;
      });
    } finally {
      unblock();
    }
    const firstResult = await first;
    assert.deepEqual(firstResult.engines, ['chatgpt']);
    assert.deepEqual(second?.engines, []);
    assert.equal(firstResult.run_ids.chatgpt, second?.run_ids.chatgpt);
    assert.equal(executed, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('local executor failure closes its reservation without exposing provider details and allows retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-geo-cli-failed-reservation-'));
  const db = openSqliteDb(join(root, 'test.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@example.test');
    await db.createBrand({
      id: 'retry-brand', user_id: 'test-user', name: 'Acme', domain: 'acme.com',
      category: null, competitors: [], aliases: [], exclude_terms: [],
      refresh_frequency: 'manual',
    });
    const brand = await db.getBrand('retry-brand');
    assert.ok(brand);
    const prompts: Prompt[] = [{
      id: 'retry-prompt', brand_id: brand.id, text: 'Independent category query',
      intent_stage: null, shape: null, active: 1, created_at: 0,
    }];

    await assert.rejects(
      runLocalRefresh(db, {}, brand, prompts, ['chatgpt'], async () => {
        throw new Error('sensitive provider diagnostic');
      }),
      /sensitive provider diagnostic/,
    );
    const failedRun = await db.getLatestRun(brand.id, 'chatgpt');
    assert.ok(failedRun);
    assert.equal(failedRun.status, 'failed');
    assert.ok(failedRun.completed_at);
    assert.match(failedRun.error ?? '', /Local engine execution failed/);
    assert.doesNotMatch(failedRun.error ?? '', /sensitive provider diagnostic/);

    let retryCalls = 0;
    const retried = await runLocalRefresh(db, {}, brand, prompts, ['chatgpt'], async (_env, _brand, _prompts, run) => {
      retryCalls += 1;
      await db.updateRun(run.run_id, { status: 'completed', completed_at: Date.now() });
    });
    assert.deepEqual(retried.engines, ['chatgpt']);
    assert.notEqual(retried.run_ids.chatgpt, failedRun.id);
    assert.equal(retryCalls, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed local engine does not prevent independent requested engines from completing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-geo-cli-independent-engines-'));
  const db = openSqliteDb(join(root, 'test.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@example.test');
    await db.createBrand({
      id: 'independent-engines', user_id: 'test-user', name: 'Acme', domain: 'acme.com',
      category: null, competitors: [], aliases: [], exclude_terms: [],
      refresh_frequency: 'manual',
    });
    const brand = await db.getBrand('independent-engines');
    assert.ok(brand);
    const prompts: Prompt[] = [{
      id: 'prompt-1', brand_id: brand.id, text: 'Independent category query',
      intent_stage: null, shape: null, active: 1, created_at: 0,
    }];

    const called: string[] = [];
    await assert.rejects(
      runLocalRefresh(db, {}, brand, prompts, ['chatgpt', 'claude'], async (_env, _brand, _prompts, run) => {
        called.push(run.engine);
        if (run.engine === 'chatgpt') throw new Error('first provider failed');
        await db.updateRun(run.run_id, { status: 'completed', completed_at: Date.now() });
      }),
      /first provider failed/,
    );
    assert.deepEqual(called, ['chatgpt', 'claude']);
    assert.equal((await db.getLatestRun(brand.id, 'chatgpt'))?.status, 'failed');
    assert.equal((await db.getLatestRun(brand.id, 'claude'))?.status, 'completed');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
