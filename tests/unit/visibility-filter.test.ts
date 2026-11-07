import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type { Brand, Db, Prompt, PromptResponse, Run } from '../../src/db/types.ts';
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

function run(engine: EngineName, timestamp: number, mode: 'live' | 'batch' = 'live'): Run {
  return {
    id: `run-${engine}`,
    brand_id: brand.id,
    engine,
    mode,
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
  missing_requested_engines: string[];
  measurement_scope: {
    search_requested: { score: number | null; engines: string[] };
    model_only: { score: number | null; engines: string[] };
    mixed_modes: boolean;
    note: string;
  };
  google_search_sampling: null | {
    engines: string[];
    country: 'us';
    language: 'en';
    scope_note: string;
  };
  freshness: {
    oldest_refreshed_at: string;
    newest_refreshed_at: string;
    age_spread_hours: number;
    mixed_age_warning: boolean;
    older_engines: string[];
  };
  prompt_set_comparability: {
    active_prompt_count: number;
    engines_with_retired_prompt_evidence: string[];
    historical_prompt_warning: boolean;
    note: string;
  };
  configuration_comparability: {
    brand_updated_at: string;
    engines_scanned_before_update: string[];
    historical_settings_warning: boolean;
    note: string;
  };
  per_engine: Array<{
    engine: string;
    measurement_mode: 'search_requested' | 'model_only';
    score: number;
    refreshed_at: string;
    coverage: {
      usable_prompts: number;
      expected_prompts: number;
      percent: number;
      partial: boolean;
    };
  }>;
  top_winning_prompts: Array<{
    prompt: string;
    engines_cited_in: string[];
    engines_mentioned_in: string[];
    engines_with_brand_link: string[];
  }>;
  winning_prompt_evidence_note: string;
  top_losing_prompts: Array<{ prompt: string; competitors_cited: string[] }>;
};

type VisibilityTool = {
  handler: (args: {
    brand_id: string;
    engines?: EngineName[];
  }) => Promise<{ structuredContent: VisibilitySnapshot }>;
};

function registerVisibilityTool(overrides?: {
  runs?: Partial<Record<EngineName, Run>>;
  responses?: Record<string, PromptResponse[]>;
  activePromptIds?: string[];
  brand?: Brand;
}): VisibilityTool {
  let visibility: VisibilityTool | undefined;
  const runMap: Partial<Record<EngineName, Run>> = { ...runs, ...overrides?.runs };
  const responseMap: Record<string, PromptResponse[]> = { ...responses, ...overrides?.responses };
  const activePromptIds = overrides?.activePromptIds ?? [
    ...new Set(Object.values(responseMap).flat().map((row) => row.prompt_id)),
  ];
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'check_visibility') {
        visibility = { handler: handler as VisibilityTool['handler'] };
      }
    },
  } as unknown as McpServer;

  registerTools(server, {
    db: {
      getBrand: async () => overrides?.brand ?? brand,
      getLatestCompletedRun: async (_brandId, engine) =>
        runMap[engine as EngineName] ?? null,
      getResponsesForRun: async (runId) => responseMap[runId] ?? [],
      getActivePrompts: async () => activePromptIds.map((id): Prompt => ({
        id, brand_id: brand.id, text: id, intent_stage: null, shape: null,
        active: 1, created_at: 0,
      })),
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
  assert.equal(result.structuredContent.google_search_sampling, null);
  assert.deepEqual(result.structuredContent.per_engine, [
    {
      engine: 'claude',
      measurement_mode: 'model_only',
      score: 50,
      prompts_appeared_in: 1,
      total_prompts: 2,
      refreshed_at: new Date(claudeTimestamp).toISOString(),
      coverage: { usable_prompts: 2, expected_prompts: 2, percent: 100, partial: false },
    },
  ]);
  assert.deepEqual(result.structuredContent.top_winning_prompts, [
    {
      prompt: 'Claude winner',
      engines_cited_in: ['claude'],
      engines_mentioned_in: ['claude'],
      engines_with_brand_link: [],
    },
  ]);
  assert.match(result.structuredContent.winning_prompt_evidence_note, /not source citations/);
  assert.deepEqual(result.structuredContent.top_losing_prompts, [
    { prompt: 'Claude loss', competitors_cited: ['beta.com'] },
  ]);
  assert.equal(
    result.structuredContent.refreshed_at,
    new Date(claudeTimestamp).toISOString(),
  );
});

test('check_visibility discloses US-English sampling only when Google search results are included', async () => {
  const googleRun = run('ai_overviews', chatgptTimestamp);
  const visibility = registerVisibilityTool({
    runs: { ai_overviews: googleRun },
    responses: {
      [googleRun.id]: [response('ai_overviews', 'google-prompt', 'Google result', 1)],
    },
  });
  const result = await visibility.handler({ brand_id: brand.id, engines: ['ai_overviews'] });
  assert.deepEqual(result.structuredContent.google_search_sampling?.engines, ['ai_overviews']);
  assert.equal(result.structuredContent.google_search_sampling?.country, 'us');
  assert.equal(result.structuredContent.google_search_sampling?.language, 'en');
  assert.match(result.structuredContent.google_search_sampling?.scope_note ?? '', /other markets or languages/);
});

test('check_visibility deduplicates repeated engine filters before scoring', async () => {
  const visibility = registerVisibilityTool();

  const result = await visibility.handler({
    brand_id: brand.id,
    engines: ['claude', 'claude'],
  });

  assert.equal(result.structuredContent.overall_score, 50);
  assert.deepEqual(result.structuredContent.per_engine, [
    {
      engine: 'claude',
      measurement_mode: 'model_only',
      score: 50,
      prompts_appeared_in: 1,
      total_prompts: 2,
      refreshed_at: new Date(claudeTimestamp).toISOString(),
      coverage: { usable_prompts: 2, expected_prompts: 2, percent: 100, partial: false },
    },
  ]);
});

test('check_visibility treats omitted and empty engine filters as all engines', async () => {
  const visibility = registerVisibilityTool();

  const omitted = await visibility.handler({ brand_id: brand.id });
  const empty = await visibility.handler({ brand_id: brand.id, engines: [] });

  assert.equal(omitted.structuredContent.overall_score, 75);
  assert.deepEqual(omitted.structuredContent.measurement_scope.search_requested, {
    score: 100, engines: ['chatgpt'],
  });
  assert.deepEqual(omitted.structuredContent.measurement_scope.model_only, {
    score: 50, engines: ['claude'],
  });
  assert.equal(omitted.structuredContent.measurement_scope.mixed_modes, true);
  assert.match(omitted.structuredContent.measurement_scope.note, /latest usable observation per distinct prompt/);
  assert.match(omitted.structuredContent.measurement_scope.note, /not independently verified search citations/);
  assert.deepEqual(
    omitted.structuredContent.per_engine.map((engine) => engine.engine),
    ['chatgpt', 'claude'],
  );
  assert.equal(
    omitted.structuredContent.refreshed_at,
    new Date(chatgptTimestamp).toISOString(),
  );
  assert.deepEqual(
    omitted.structuredContent.per_engine.map(({ engine, refreshed_at }) => ({
      engine,
      refreshed_at,
    })),
    [
      {
        engine: 'chatgpt',
        refreshed_at: new Date(chatgptTimestamp).toISOString(),
      },
      {
        engine: 'claude',
        refreshed_at: new Date(claudeTimestamp).toISOString(),
      },
    ],
  );
  assert.deepEqual(empty.structuredContent, omitted.structuredContent);
  assert.deepEqual(omitted.structuredContent.freshness, {
    oldest_refreshed_at: new Date(claudeTimestamp).toISOString(),
    newest_refreshed_at: new Date(chatgptTimestamp).toISOString(),
    age_spread_hours: 24,
    mixed_age_warning: true,
    older_engines: ['claude'],
  });
});

test('check_visibility excludes unselected engines from age warnings', async () => {
  const visibility = registerVisibilityTool();
  const result = await visibility.handler({ brand_id: brand.id, engines: ['claude'] });
  assert.deepEqual(result.structuredContent.freshness, {
    oldest_refreshed_at: new Date(claudeTimestamp).toISOString(),
    newest_refreshed_at: new Date(claudeTimestamp).toISOString(),
    age_spread_hours: 0,
    mixed_age_warning: false,
    older_engines: [],
  });
});

test('batch ChatGPT results are not falsely classified as live-search observations', async () => {
  const batchRun = run('chatgpt', chatgptTimestamp, 'batch');
  const visibility = registerVisibilityTool({ runs: { chatgpt: batchRun } });
  const result = await visibility.handler({ brand_id: brand.id, engines: ['chatgpt'] });
  assert.equal(result.structuredContent.overall_score, 100);
  assert.deepEqual(result.structuredContent.measurement_scope.search_requested, {
    score: null, engines: [],
  });
  assert.deepEqual(result.structuredContent.measurement_scope.model_only, {
    score: 100, engines: ['chatgpt'],
  });
  assert.equal(result.structuredContent.per_engine[0].measurement_mode, 'model_only');
  assert.equal(result.structuredContent.measurement_scope.mixed_modes, false);
});

test('check_visibility keeps sub-day engine scans out of mixed-age warnings', async () => {
  const recentClaude = Date.UTC(2026, 0, 2, 11, 30);
  const tool = registerVisibilityTool({ runs: { claude: run('claude', recentClaude) } });
  const result = await tool.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.freshness.age_spread_hours, 0.5);
  assert.equal(result.structuredContent.freshness.mixed_age_warning, false);
  assert.deepEqual(result.structuredContent.freshness.older_engines, []);
});

test('check_visibility does not fall back to other engines when the selection has no data', async () => {
  const visibility = registerVisibilityTool();

  await assert.rejects(
    visibility.handler({ brand_id: brand.id, engines: ['gemini'] }),
    /No visibility data yet for the selected engines/,
  );
});

test('check_visibility identifies explicitly requested engines missing usable scan data', async () => {
  const visibility = registerVisibilityTool();
  const result = await visibility.handler({
    brand_id: brand.id,
    engines: ['chatgpt', 'gemini', 'gemini', 'claude'],
  });
  assert.equal(result.structuredContent.overall_score, 75);
  assert.deepEqual(result.structuredContent.missing_requested_engines, ['gemini']);
  assert.deepEqual(result.structuredContent.per_engine.map(({ engine }) => engine), ['chatgpt', 'claude']);

  const implicit = await visibility.handler({ brand_id: brand.id });
  assert.deepEqual(implicit.structuredContent.missing_requested_engines, []);
});

test('check_visibility labels a score based on partial successful prompt coverage', async () => {
  const partialRun: Run = {
    ...runs.claude,
    status: 'in_progress',
    prompts_total: 5,
    prompts_completed: 1,
    completed_at: null,
  };
  const tool = registerVisibilityTool({
    runs: { claude: partialRun },
    responses: { [partialRun.id]: [response('claude', 'only-ok', 'Observed mention', 1)] },
  });
  const result = await tool.handler({ brand_id: brand.id, engines: ['claude'] });
  assert.equal(result.structuredContent.overall_score, 100);
  assert.deepEqual(result.structuredContent.per_engine[0].coverage, {
    usable_prompts: 1,
    expected_prompts: 5,
    percent: 20,
    partial: true,
  });
});

test('check_visibility flags historical prompt evidence after a prompt-set replacement', async () => {
  const visibility = registerVisibilityTool({
    activePromptIds: ['chatgpt-win', 'chatgpt-second-win'],
  });
  const mixed = (await visibility.handler({ brand_id: brand.id })).structuredContent;
  assert.deepEqual(mixed.prompt_set_comparability, {
    active_prompt_count: 2,
    engines_with_retired_prompt_evidence: ['claude'],
    historical_prompt_warning: true,
    note: 'Latest scored responses from the listed engines include prompts no longer in the active set. Their scores remain historical observations and should not be compared as measurements of the current prompt set. Partial scan coverage is reported separately.',
  });
  const current = (await visibility.handler({
    brand_id: brand.id, engines: ['chatgpt'],
  })).structuredContent;
  assert.equal(current.prompt_set_comparability.historical_prompt_warning, false);
  assert.deepEqual(current.prompt_set_comparability.engines_with_retired_prompt_evidence, []);
  assert.match(current.prompt_set_comparability.note, /No retired prompt IDs/);
});

test('missing successful responses do not count as retired prompts', async () => {
  const partial = { ...runs.claude, prompts_total: 3, prompts_completed: 1 };
  const visibility = registerVisibilityTool({
    runs: { claude: partial },
    responses: {
      [partial.id]: [response('claude', 'still-active', 'Observed prompt', 1)],
    },
    activePromptIds: ['still-active', 'new-but-unobserved'],
  });
  const snapshot = (await visibility.handler({
    brand_id: brand.id, engines: ['claude'],
  })).structuredContent;
  assert.equal(snapshot.per_engine[0].coverage.partial, true);
  assert.equal(snapshot.prompt_set_comparability.historical_prompt_warning, false);
});

test('check_visibility identifies engines measured before a brand configuration update', async () => {
  const updatedAt = Date.UTC(2026, 0, 2, 0);
  const tool = registerVisibilityTool({ brand: { ...brand, updated_at: updatedAt } });
  const snapshot = (await tool.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(snapshot.configuration_comparability.brand_updated_at, new Date(updatedAt).toISOString());
  assert.deepEqual(snapshot.configuration_comparability.engines_scanned_before_update, ['claude']);
  assert.equal(snapshot.configuration_comparability.historical_settings_warning, true);
  assert.match(snapshot.configuration_comparability.note, /cannot establish which settings changed/);

  const filtered = (await tool.handler({ brand_id: brand.id, engines: ['chatgpt'] })).structuredContent;
  assert.deepEqual(filtered.configuration_comparability.engines_scanned_before_update, []);
  assert.equal(filtered.configuration_comparability.historical_settings_warning, false);
});

test('check_visibility does not infer a configuration mismatch from older metadata', async () => {
  const tool = registerVisibilityTool({ brand: { ...brand, updated_at: claudeTimestamp - 1 } });
  const snapshot = (await tool.handler({ brand_id: brand.id })).structuredContent;
  assert.deepEqual(snapshot.configuration_comparability.engines_scanned_before_update, []);
  assert.equal(snapshot.configuration_comparability.historical_settings_warning, false);
});
