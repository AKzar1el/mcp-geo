import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLocalManagementTools } from '../../src/core/tools.ts';
import { openSqliteDb } from '../../src/db/sqlite.ts';

type ManagementResult = { structuredContent: Record<string, unknown> };
type ManagementHandler = (args: Record<string, unknown>) => Promise<ManagementResult>;

test('local brand and prompt configuration guides users through a provider-free scan preview', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-geo-preview-next-steps-'));
  const db = openSqliteDb(join(root, 'geo.sqlite'));
  const handlers = new Map<string, ManagementHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: ManagementHandler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  const invoke = async (name: string, args: Record<string, unknown>) => {
    const handler = handlers.get(name);
    assert.ok(handler, `missing ${name} handler`);
    return (await handler(args)).structuredContent;
  };
  const expectPreviewFirst = (steps: unknown) => {
    assert.match(String(steps), /refresh_brand[^.]*preview_only=true/i);
    assert.match(String(steps), /without provider requests/i);
    assert.match(String(steps), /provider charges/i);
  };

  try {
    registerLocalManagementTools(server, { db, env: {} });

    const seeded = await invoke('track_brand', {
      brand_id: 'acme',
      name: 'Acme',
      domain: 'acme.com',
      category: 'Project management software',
      prompt_generation: 'fallback',
      prompt_count: 20,
      refresh_frequency: 'weekly',
    });
    assert.equal(seeded.seeded, true);
    expectPreviewFirst(seeded.next_steps);

    const noCategory = await invoke('track_brand', {
      brand_id: 'plain',
      name: 'Plain',
      domain: 'plain.example',
      prompt_generation: 'fallback',
      prompt_count: 20,
      refresh_frequency: 'weekly',
    });
    assert.equal(noCategory.seeded, true);
    expectPreviewFirst(noCategory.next_steps);
    assert.match(String(noCategory.next_steps), /category/i);

    const categoryUpdate = await invoke('update_brand', {
      brand_id: 'acme',
      category: 'CRM software',
    });
    expectPreviewFirst(categoryUpdate.next_steps);
    assert.match(String(categoryUpdate.next_steps), /list_prompts/i);

    const ordinaryUpdate = await invoke('update_brand', {
      brand_id: 'acme',
      refresh_frequency: 'manual',
    });
    expectPreviewFirst(ordinaryUpdate.next_steps);

    const prompts = await invoke('set_prompts', {
      brand_id: 'acme',
      prompts: ['Best CRM software for small teams'],
    });
    expectPreviewFirst(prompts.next_steps);
    assert.equal((await db.getActivePrompts('acme')).length, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
