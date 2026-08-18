import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type { Brand, Db, Prompt } from '../../src/db/types.ts';
import type { EngineName } from '../../src/core/engines.ts';

const brand: Brand = {
  id: 'acme',
  user_id: 'test-user',
  domain: 'acme.com',
  name: 'Acme',
  category: null,
  competitors: [],
  aliases: [],
  exclude_terms: [],
  refresh_frequency: 'weekly',
  created_at: 0,
  updated_at: 0,
};

const prompt: Prompt = {
  id: 'prompt-1',
  brand_id: brand.id,
  text: 'What is Acme?',
  intent_stage: null,
  shape: null,
  active: 1,
  created_at: 0,
};

type RefreshTool = {
  description: string;
  handler: (args: { brand_id: string; engines?: EngineName[] }) => Promise<{
    structuredContent: Record<string, unknown>;
  }>;
};

function registerRefreshTool(
  refreshExecution: 'async' | 'sync',
  namespaced = false,
): RefreshTool {
  const tools = new Map<string, RefreshTool>();
  const server = {
    registerTool(name: string, config: { description: string }, handler: unknown) {
      tools.set(name, {
        description: config.description,
        handler: handler as RefreshTool['handler'],
      });
    },
  } as unknown as McpServer;

  registerTools(
    server,
    {
      db: {
        getBrand: async () => brand,
        getActivePrompts: async () => [prompt],
      } as Db,
      env: {
        OPENAI_API_KEY: 'test-openai-key',
        ANTHROPIC_API_KEY: 'test-anthropic-key',
      },
      refreshExecution,
      runEnginesInline: async (_brand, _prompts, engines) => ({
        run_ids: Object.fromEntries(
          engines.map((engine) => [engine, `run-${engine}`]),
        ),
        engines,
      }),
    },
    { namespaced },
  );

  const refresh = tools.get(namespaced ? 'visibility.refresh' : 'refresh_brand');
  assert.ok(refresh, 'refresh tool registration missing');
  return refresh;
}

test('async refresh metadata and result report dispatched scans', async () => {
  const refresh = registerRefreshTool('async', true);
  assert.match(refresh.description, /returns immediately with run IDs/i);

  const result = await refresh.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.message, 'Refresh started for 2 engines');
  assert.equal(result.structuredContent.estimated_completion_seconds, 30);
});

test('sync refresh metadata and result report completed scans', async () => {
  const refresh = registerRefreshTool('sync');
  assert.match(
    refresh.description,
    /returns only after all selected engine scans finish/i,
  );
  assert.doesNotMatch(refresh.description, /returns immediately/i);

  const result = await refresh.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.message, 'Refresh completed for 2 engines');
  assert.equal(result.structuredContent.estimated_completion_seconds, 0);
});
