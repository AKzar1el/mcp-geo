import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type { Brand, Db, PromptResponse, Run } from '../../src/db/types.ts';
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

const claudeTimestamp = Date.UTC(2026, 0, 1, 12);
const chatgptTimestamp = Date.UTC(2026, 0, 2, 12);

function run(engine: EngineName, timestamp: number): Run {
  return {
    id: `run-${engine}`,
    brand_id: brand.id,
    engine,
    mode: 'live',
    status: 'completed',
    batch_id: null,
    prompts_total: 2,
    prompts_completed: 2,
    cost_eur_estimate: null,
    error: null,
    started_at: timestamp,
    completed_at: timestamp,
  };
}

function response(
  engine: EngineName,
  promptId: string,
  promptText: string,
  brandMentioned: number,
  competitors: string[] = [],
): PromptResponse {
  return {
    id: `${engine}-${promptId}`,
    run_id: `run-${engine}`,
    prompt_id: promptId,
    prompt_text: promptText,
    engine,
    raw_response: '',
    brand_mentioned: brandMentioned,
    brand_cited_with_link: 0,
    cited_urls: [],
    competitors_mentioned: competitors,
    engine_citations: [],
    status: 'ok',
    error_message: null,
    captured_at: 0,
  };
}

const runs = {
  chatgpt: run('chatgpt', chatgptTimestamp),
  claude: run('claude', claudeTimestamp),
};

const responses = {
  [runs.chatgpt.id]: [
    response('chatgpt', 'chatgpt-win', 'ChatGPT winner', 1),
    response('chatgpt', 'chatgpt-second-win', 'ChatGPT second winner', 1),
  ],
  [runs.claude.id]: [
    response('claude', 'claude-win', 'Claude winner', 1),
    response('claude', 'claude-loss', 'Claude loss', 0, ['beta.com']),
  ],
};

type VisibilitySnapshot = {
  refreshed_at: string;
  overall_score: number;
  per_engine: Array<{ engine: string; score: number }>;
  top_winning_prompts: Array<{ prompt: string; engines_cited_in: string[] }>;
  top_losing_prompts: Array<{ prompt: string; competitors_cited: string[] }>;
};

type VisibilityTool = {
  handler: (args: {
    brand_id: string;
    engines?: EngineName[];
  }) => Promise<{ structuredContent: VisibilitySnapshot }>;
};

function registerVisibilityTool(): VisibilityTool {
  let visibility: VisibilityTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'check_visibility') {
        visibility = { handler: handler as VisibilityTool['handler'] };
      }
    },
  } as unknown as McpServer;

  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getLatestCompletedRun: async (_brandId, engine) =>
        runs[engine as keyof typeof runs] ?? null,
      getResponsesForRun: async (runId) => responses[runId as keyof typeof responses] ?? [],
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  assert.ok(visibility, 'check_visibility tool registration missing');
  return visibility;
}

test('check_visibility scopes every snapshot field to the requested engine', async () => {
  const visibility = registerVisibilityTool();

  const result = await visibility.handler({
    brand_id: brand.id,
    engines: ['claude'],
  });

  assert.equal(result.structuredContent.overall_score, 50);
  assert.deepEqual(result.structuredContent.per_engine, [
    { engine: 'claude', score: 50, prompts_appeared_in: 1, total_prompts: 2 },
  ]);
  assert.deepEqual(result.structuredContent.top_winning_prompts, [
    { prompt: 'Claude winner', engines_cited_in: ['claude'] },
  ]);
  assert.deepEqual(result.structuredContent.top_losing_prompts, [
    { prompt: 'Claude loss', competitors_cited: ['beta.com'] },
  ]);
  assert.equal(
    result.structuredContent.refreshed_at,
    new Date(claudeTimestamp).toISOString(),
  );
});

test('check_visibility treats omitted and empty engine filters as all engines', async () => {
  const visibility = registerVisibilityTool();

  const omitted = await visibility.handler({ brand_id: brand.id });
  const empty = await visibility.handler({ brand_id: brand.id, engines: [] });

  assert.equal(omitted.structuredContent.overall_score, 75);
  assert.deepEqual(
    omitted.structuredContent.per_engine.map((engine) => engine.engine),
    ['chatgpt', 'claude'],
  );
  assert.equal(
    omitted.structuredContent.refreshed_at,
    new Date(chatgptTimestamp).toISOString(),
  );
  assert.deepEqual(empty.structuredContent, omitted.structuredContent);
});

test('check_visibility does not fall back to other engines when the selection has no data', async () => {
  const visibility = registerVisibilityTool();

  await assert.rejects(
    visibility.handler({ brand_id: brand.id, engines: ['gemini'] }),
    /No visibility data yet for the selected engines/,
  );
});
