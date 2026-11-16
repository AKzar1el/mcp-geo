import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type { Brand, Db, Prompt } from '../../src/db/types.ts';
import type { EngineName } from '../../src/core/engines.ts';
import type { EngineKeys } from '../../src/core/engines.ts';

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
  handler: (args: { brand_id: string; engines?: EngineName[]; preview_only?: boolean }) => Promise<{
    structuredContent: Record<string, unknown>;
  }>;
};

function registerRefreshTool(
  refreshExecution: 'async' | 'sync',
  namespaced = false,
  env: EngineKeys = {
    OPENAI_API_KEY: 'test-openai-key',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
  },
  failedEngines: EngineName[] = [],
  onDispatch?: () => void,
  activePrompts: Prompt[] = [prompt],
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
        getActivePrompts: async () => activePrompts,
      } as Db,
      env,
      refreshExecution,
      runEnginesInline: async (_brand, _prompts, engines) => {
        onDispatch?.();
        return {
          run_ids: Object.fromEntries(
            engines.map((engine) => [engine, `run-${engine}`]),
          ),
          engines,
          failed_engines: failedEngines,
        };
      },
    },
    { namespaced },
  );

  const refresh = tools.get(namespaced ? 'visibility.refresh' : 'refresh_brand');
  assert.ok(refresh, 'refresh tool registration missing');
  return refresh;
}

test('async refresh metadata and result report dispatched scans', async () => {
  const refresh = registerRefreshTool('async', true);
  assert.match(refresh.description, /returns run IDs immediately/i);

  const result = await refresh.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.message, 'Refresh started for 2 engines');
  assert.equal(result.structuredContent.estimated_completion_seconds, 30);
});

test('sync refresh metadata and result report completed scans', async () => {
  const refresh = registerRefreshTool('sync');
  assert.match(refresh.description, /return after completion/i);
  assert.doesNotMatch(refresh.description, /returns immediately/i);

  const result = await refresh.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.message, 'Refresh completed for 2 engines');
  assert.equal(result.structuredContent.estimated_completion_seconds, 0);
});

test('sync partial refresh discloses failures and preserves successful run IDs without claiming full completion', async () => {
  const refresh = registerRefreshTool('sync', false, undefined, ['chatgpt']);
  const result = await refresh.handler({ brand_id: brand.id, engines: ['chatgpt', 'claude'] });

  assert.match(String(result.structuredContent.message), /partially completed for 1 engine; failed: chatgpt/i);
  assert.match(String(result.structuredContent.message), /provider calls may incur charges/i);
  assert.deepEqual(result.structuredContent.failed_engines, ['chatgpt']);
  assert.deepEqual(result.structuredContent.run_ids, { chatgpt: 'run-chatgpt', claude: 'run-claude' });
  assert.equal(result.structuredContent.estimated_completion_seconds, 0);
});

test('explicit empty refresh engine selection fails closed instead of spending on all providers', async () => {
  const refresh = registerRefreshTool('sync');

  await assert.rejects(
    refresh.handler({ brand_id: brand.id, engines: [] }),
    /at least one engine|omit engines/i,
  );

  const omitted = await refresh.handler({ brand_id: brand.id });
  assert.deepEqual(omitted.structuredContent.run_ids, {
    chatgpt: 'run-chatgpt',
    claude: 'run-claude',
  });
});

test('refresh names an explicitly requested engine when its provider key is unavailable', async () => {
  const refresh = registerRefreshTool('sync', false, {
    OPENAI_API_KEY: 'test-openai-key',
  });

  await assert.rejects(
    refresh.handler({ brand_id: brand.id, engines: ['claude'] }),
    /requested engines are not configured: claude/i,
  );
});

test('mixed engine selection discloses requested but unconfigured engines', async () => {
  const refresh = registerRefreshTool('sync', false, {
    OPENAI_API_KEY: 'test-openai-key',
  });
  const result = await refresh.handler({
    brand_id: brand.id,
    engines: ['chatgpt', 'claude', 'claude'],
  });
  assert.equal(result.structuredContent.message, 'Refresh completed for 1 engine; skipped unconfigured: claude');
  assert.deepEqual(result.structuredContent.run_ids, { chatgpt: 'run-chatgpt' });
  assert.deepEqual(result.structuredContent.skipped_unconfigured_engines, ['claude']);
});

test('refresh deduplicates explicitly requested engines before dispatch', async () => {
  const refresh = registerRefreshTool('sync');

  const result = await refresh.handler({
    brand_id: brand.id,
    engines: ['chatgpt', 'chatgpt', 'claude', 'chatgpt'],
  });

  assert.equal(result.structuredContent.message, 'Refresh completed for 2 engines');
  assert.deepEqual(result.structuredContent.run_ids, {
    chatgpt: 'run-chatgpt',
    claude: 'run-claude',
  });
});

test('preview_only exposes planned prompt-engine scope without provider dispatch or run IDs', async () => {
  let dispatches = 0;
  const refresh = registerRefreshTool('async', true, {
    OPENAI_API_KEY: 'test-openai-key',
  }, [], () => { dispatches += 1; });

  const result = await refresh.handler({
    brand_id: brand.id,
    engines: ['chatgpt', 'chatgpt', 'claude'],
    preview_only: true,
  });

  assert.match(refresh.description, /preview_only=true/i);
  assert.equal(dispatches, 0);
  assert.deepEqual(result.structuredContent.run_ids, {});
  assert.deepEqual(result.structuredContent.planned_engines, ['chatgpt']);
  assert.deepEqual(result.structuredContent.skipped_unconfigured_engines, ['claude']);
  assert.equal(result.structuredContent.active_prompt_count, 1);
  assert.equal(result.structuredContent.planned_prompt_engine_pairs, 1);
  assert.equal(result.structuredContent.preview_only, true);
  assert.match(String(result.structuredContent.message), /no provider requests/i);
  assert.match(String(result.structuredContent.cost_note), /not.*bill|not.*cost/i);
});

test('provider-free preview explains missing provider configuration without dispatching', async () => {
  let dispatches = 0;
  const refresh = registerRefreshTool('sync', false, {}, [], () => { dispatches += 1; });

  const preview = await refresh.handler({ brand_id: brand.id, preview_only: true });
  assert.equal(dispatches, 0);
  assert.equal(preview.structuredContent.preview_only, true);
  assert.equal(preview.structuredContent.ready_to_refresh, false);
  assert.deepEqual(preview.structuredContent.run_ids, {});
  assert.deepEqual(preview.structuredContent.planned_engines, []);
  assert.equal(preview.structuredContent.active_prompt_count, 1);
  assert.equal(preview.structuredContent.planned_prompt_engine_pairs, 0);
  assert.match(String(preview.structuredContent.readiness_warnings), /provider.*key|api key/i);

  const explicit = await refresh.handler({ brand_id: brand.id, engines: ['claude'], preview_only: true });
  assert.deepEqual(explicit.structuredContent.skipped_unconfigured_engines, ['claude']);
  assert.equal(dispatches, 0);
  await assert.rejects(refresh.handler({ brand_id: brand.id }), /No engines available/i);
});

test('preview with zero active prompts offers a no-cost readiness diagnosis, not a scan', async () => {
  let dispatches = 0;
  const refresh = registerRefreshTool('sync', false, {
    OPENAI_API_KEY: 'test-openai-key',
  }, [], () => { dispatches += 1; }, []);

  const preview = await refresh.handler({ brand_id: brand.id, preview_only: true });
  assert.equal(dispatches, 0);
  assert.equal(preview.structuredContent.ready_to_refresh, false);
  assert.deepEqual(preview.structuredContent.run_ids, {});
  assert.deepEqual(preview.structuredContent.planned_engines, ['chatgpt']);
  assert.equal(preview.structuredContent.active_prompt_count, 0);
  assert.equal(preview.structuredContent.planned_prompt_engine_pairs, 0);
  assert.match(String(preview.structuredContent.readiness_warnings), /active prompts/i);
  await assert.rejects(refresh.handler({ brand_id: brand.id }), /no active prompts/i);
});
