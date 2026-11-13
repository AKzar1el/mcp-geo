import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type { Brand, Db, PromptResponse } from '../../src/db/types.ts';

const brand: Brand = {
  id: 'acme',
  user_id: 'test-user',
  domain: 'acme.com',
  name: 'Acme',
  category: 'Project management',
  competitors: ['asana.com', 'monday.com'],
  aliases: [],
  exclude_terms: [],
  refresh_frequency: 'weekly',
  created_at: 0,
  updated_at: 0,
};

function response(
  id: string,
  prompt: string,
  brandMentioned: number,
  competitors: string[],
): PromptResponse {
  return {
    id,
    run_id: `run-${id}`,
    prompt_id: `prompt-${id}`,
    prompt_text: prompt,
    engine: 'chatgpt',
    raw_response: '',
    brand_mentioned: brandMentioned,
    brand_cited_with_link: 0,
    cited_urls: [],
    competitors_mentioned: competitors,
    engine_citations: [],
    status: 'ok',
    error_message: null,
    captured_at: Date.now(),
  };
}

type ComparisonResult = {
  brand_id: string;
  days: number;
  observation_coverage: {
    status: 'not_compared' | 'no_observations' | 'observed';
    successful_responses: number;
    per_engine: Array<{
      engine: string;
      successful_responses: number;
      distinct_runs: number;
      distinct_prompts: number;
      last_observed_at: string;
    }>;
    note: string;
  };
  identity_attribution: {
    last_identity_change_at: string | null;
    excluded_responses: number;
    note: string;
  };
  google_search_sampling: {
    engines: string[];
    country: 'us';
    language: 'en';
    scope_note: string;
  } | null;
  your_share_of_voice_pct: number;
  your_mentions: number;
  comparison_semantics: string;
  historical_coverage_note: string;
  outside_current_tracking: string[];
  prompt_set_scope: {
    selection: 'full_window' | 'active_only';
    active_prompt_count: number | null;
    excluded_observations: number;
    note: string;
  };
  engine_scope: {
    selection: 'all_stored' | 'selected';
    requested_engines: string[];
    not_observed_engines: string[];
    unmeasured_scoped_engines: string[];
    note: string;
  };
  requested_competitor_domains: string[] | null;
  prompts_you_win: Array<{ prompt: string; you_cited_by: string[]; competitors_cited: string[] }>;
  prompts_brand_only: Array<{ prompt: string; you_cited_by: string[]; competitors_cited: string[] }>;
  prompts_co_mentioned: Array<{ prompt: string; you_cited_by: string[]; competitors_cited: string[] }>;
  competitors: Array<{
    domain: string;
    share_of_voice_pct: number;
    mentions: number;
    prompts_won_against_you: string[];
  }>;
};

type ComparisonTool = {
  handler: (args: {
    brand_id: string;
    days?: number;
    competitor_domains?: string[];
    active_prompts_only?: boolean;
    engines?: string[];
  }) => Promise<{ structuredContent: ComparisonResult }>;
};

test('comparison scopes engine evidence before shares, prompt rankings and Google sampling', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') comparison = { handler: handler as ComparisonTool['handler'] };
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getResponsesSince: async () => [
        response('brand-chatgpt', 'best project tracker', 1, []),
        { ...response('asana-claude', 'compare project trackers', 0, ['asana.com']), engine: 'claude' },
        { ...response('monday-google', 'team planning software', 0, ['monday.com']), engine: 'ai_overviews' },
      ],
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);

  const full = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(full.observation_coverage.successful_responses, 3);
  assert.equal(full.your_share_of_voice_pct, 33);
  assert.equal(full.competitors.find((c) => c.domain === 'monday.com')?.mentions, 1);
  assert.deepEqual(full.engine_scope.requested_engines, []);
  assert.equal(full.engine_scope.selection, 'all_stored');

  const selected = (await comparison.handler({
    brand_id: brand.id, engines: ['chatgpt', 'claude', 'chatgpt'],
  })).structuredContent;
  assert.equal(selected.your_share_of_voice_pct, 50);
  assert.equal(selected.your_mentions, 1);
  assert.equal(selected.observation_coverage.successful_responses, 2);
  assert.deepEqual(selected.observation_coverage.per_engine.map((x) => x.engine), ['chatgpt', 'claude']);
  assert.equal(selected.competitors.find((c) => c.domain === 'asana.com')?.mentions, 1);
  assert.equal(selected.competitors.find((c) => c.domain === 'monday.com')?.mentions, 0);
  assert.deepEqual(selected.competitors.find((c) => c.domain === 'monday.com')?.prompts_won_against_you, []);
  assert.deepEqual(selected.prompts_you_win[0]?.you_cited_by, ['chatgpt']);
  assert.equal(selected.google_search_sampling, null);
  assert.deepEqual(selected.engine_scope.requested_engines, ['chatgpt', 'claude']);
  assert.deepEqual(selected.engine_scope.not_observed_engines, []);

  const missing = (await comparison.handler({ brand_id: brand.id, engines: ['grok'] })).structuredContent;
  assert.equal(missing.observation_coverage.status, 'no_observations');
  assert.equal(missing.your_mentions, 0);
  assert.deepEqual(missing.engine_scope.not_observed_engines, ['grok']);
  assert.match(missing.engine_scope.note, /unmeasured|not zero/i);

  const empty = (await comparison.handler({ brand_id: brand.id, engines: [] })).structuredContent;
  assert.equal(empty.engine_scope.selection, 'all_stored');
  assert.equal(empty.observation_coverage.successful_responses, 3);
});

test('comparison distinguishes selected engines excluded by the active buyer-prompt cohort', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') comparison = { handler: handler as ComparisonTool['handler'] };
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getActivePrompts: async () => [{ id: 'active' }],
      getResponsesSince: async () => [
        { ...response('active', 'current buyer query', 1, []), prompt_id: 'active' },
        { ...response('retired', 'retired buyer query', 0, ['asana.com']), engine: 'claude', prompt_id: 'retired' },
      ],
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);
  const scoped = (await comparison.handler({
    brand_id: brand.id, engines: ['chatgpt', 'claude'], active_prompts_only: true,
  })).structuredContent;
  assert.equal(scoped.your_mentions, 1);
  assert.equal(scoped.observation_coverage.successful_responses, 1);
  assert.deepEqual(scoped.engine_scope.not_observed_engines, []);
  assert.deepEqual(scoped.engine_scope.unmeasured_scoped_engines, ['claude']);
  assert.equal(scoped.prompt_set_scope.excluded_observations, 1);
});

test('compare_competitors counts one latest successful retry per run, engine and prompt', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') {
        comparison = { handler: handler as ComparisonTool['handler'] };
      }
    },
  } as unknown as McpServer;

  const sameRun = { run_id: 'run-retry', prompt_id: 'prompt-same' };
  const rows: PromptResponse[] = [
    { ...response('retry-old', 'compare project tools', 1, []), ...sameRun, captured_at: 1000 },
    { ...response('retry-z', 'compare project tools', 0, ['asana.com']), ...sameRun, captured_at: 2000 },
    { ...response('retry-mid', 'compare project tools', 1, []), ...sameRun, captured_at: 2000 },
    { ...response('later-scan', 'compare project tools', 1, []), run_id: 'run-later', prompt_id: 'prompt-same', captured_at: 3000 },
    { ...response('other-engine', 'compare project tools', 1, ['monday.com']), ...sameRun, engine: 'claude', captured_at: 4000 },
  ];
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getResponsesSince: async () => rows,
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  assert.ok(comparison);
  const result = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.observation_coverage.successful_responses, 3);
  assert.deepEqual(result.observation_coverage.per_engine, [
    {
      engine: 'chatgpt',
      successful_responses: 2,
      distinct_runs: 2,
      distinct_prompts: 1,
      last_observed_at: new Date(3000).toISOString(),
    },
    {
      engine: 'claude',
      successful_responses: 1,
      distinct_runs: 1,
      distinct_prompts: 1,
      last_observed_at: new Date(4000).toISOString(),
    },
  ]);
  assert.equal(result.your_mentions, 2);
  assert.equal(result.your_share_of_voice_pct, 50);
  assert.equal(result.competitors.find((c) => c.domain === 'asana.com')?.mentions, 1);
  assert.equal(result.competitors.find((c) => c.domain === 'monday.com')?.mentions, 1);
});

test('compare_competitors excludes pre-identity runs even when responses arrive after the edit', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') comparison = { handler: handler as ComparisonTool['handler'] };
    },
  } as unknown as McpServer;
  const changedAt = Date.now() - 5_000;
  registerTools(server, {
    db: {
      getBrand: async () => ({ ...brand, name: 'Beta', identity_changed_at: changedAt }),
      getResponsesSince: async () => [
        { ...response('old-brand', 'best old brand', 1, []), run_started_at: changedAt - 1000, captured_at: changedAt + 200 },
        { ...response('old-loss', 'old competitor win', 0, ['asana.com']), run_started_at: changedAt - 1000, captured_at: changedAt + 300 },
        { ...response('unknown-start', 'unattributable mention', 1, []), captured_at: changedAt + 350 },
        { ...response('new-loss', 'new competitor win', 0, ['monday.com']), run_started_at: changedAt + 100, captured_at: changedAt + 400 },
      ],
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);
  const result = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.your_mentions, 0);
  assert.equal(result.your_share_of_voice_pct, 0);
  assert.equal(result.observation_coverage.successful_responses, 1);
  assert.equal(result.competitors.find((c) => c.domain === 'asana.com')?.mentions, 0);
  assert.equal(result.competitors.find((c) => c.domain === 'monday.com')?.mentions, 1);
  assert.deepEqual(result.prompts_you_win, []);
  assert.equal(result.identity_attribution.excluded_responses, 3);
  assert.equal(result.identity_attribution.last_identity_change_at, new Date(changedAt).toISOString());
  assert.match(result.identity_attribution.note, /run start/i);
});

test('compare_competitors does not report old-identity-only observations as measured zeros', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') comparison = { handler: handler as ComparisonTool['handler'] };
    },
  } as unknown as McpServer;
  const changedAt = Date.now() - 2_000;
  registerTools(server, {
    db: {
      getBrand: async () => ({ ...brand, identity_changed_at: changedAt }),
      getResponsesSince: async () => [
        { ...response('obsolete', 'old brand name', 1, ['asana.com']), run_started_at: changedAt - 3_000 },
      ],
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);
  const result = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.observation_coverage.status, 'no_observations');
  assert.equal(result.observation_coverage.successful_responses, 0);
  assert.equal(result.identity_attribution.excluded_responses, 1);
  assert.equal(result.your_mentions, 0);
  assert.deepEqual(result.prompts_co_mentioned, []);
  assert.match(result.observation_coverage.note, /current-identity/i);
});

test('compare_competitors uses the full response window and exposes raw mention counts', async () => {
  let comparison: ComparisonTool | undefined;
  let capturedSince = 0;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') {
        comparison = { handler: handler as ComparisonTool['handler'] };
      }
    },
  } as unknown as McpServer;

  const rows = [
    response('1', 'best project tools', 1, ['asana.com']),
    response('2', 'asana alternatives', 0, ['asana.com', 'monday.com']),
    response('3', 'top workflow software', 0, ['monday.com']),
  ];

  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getResponsesSince: async (_brandId, since) => {
        capturedSince = since;
        return rows;
      },
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  assert.ok(comparison, 'compare_competitors tool registration missing');
  const before = Date.now() - 7 * 86_400_000;
  const result = await comparison.handler({ brand_id: brand.id, days: 7 });
  const after = Date.now() - 7 * 86_400_000;

  assert.ok(capturedSince >= before && capturedSince <= after);
  assert.equal(result.structuredContent.your_mentions, 1);
  assert.equal(result.structuredContent.your_share_of_voice_pct, 20);
  assert.equal(result.structuredContent.google_search_sampling, null);
  assert.deepEqual(result.structuredContent.outside_current_tracking, []);
  assert.match(result.structuredContent.historical_coverage_note, /not re-evaluate historical responses/);
  assert.deepEqual(
    result.structuredContent.competitors.map((competitor) => ({
      domain: competitor.domain,
      mentions: competitor.mentions,
      share_of_voice_pct: competitor.share_of_voice_pct,
    })),
    [
      { domain: 'asana.com', mentions: 2, share_of_voice_pct: 40 },
      { domain: 'monday.com', mentions: 2, share_of_voice_pct: 40 },
    ],
  );
});

test('compare_competitors discloses US/en sampling for observed Google search surfaces', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') {
        comparison = { handler: handler as ComparisonTool['handler'] };
      }
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getResponsesSince: async () => [
        { ...response('overview', 'compare tools', 1, ['asana.com']), engine: 'ai_overviews' },
        { ...response('mode', 'alternatives', 0, ['monday.com']), engine: 'ai_mode' },
      ],
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);
  const result = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.deepEqual(result.google_search_sampling?.engines, ['ai_overviews', 'ai_mode']);
  assert.equal(result.google_search_sampling?.country, 'us');
  assert.equal(result.google_search_sampling?.language, 'en');
  assert.match(result.google_search_sampling?.scope_note ?? '', /other markets or languages/);
});

test('compare_competitors separates brand-only, co-mentioned and competitor-only evidence', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') {
        comparison = { handler: handler as ComparisonTool['handler'] };
      }
    },
  } as unknown as McpServer;
  const mixedSecondEngine = {
    ...response('mixed-other-engine', 'mixed across engines', 1, ['monday.com']),
    prompt_id: 'prompt-mixed',
    engine: 'claude',
  };
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getResponsesSince: async () => [
        response('brand-only', 'brand-only prompt', 1, []),
        response('shared', 'shared prompt', 1, ['asana.com']),
        response('competitor-only', 'competitor-only prompt', 0, ['asana.com']),
        response('neither', 'neither prompt', 0, []),
        response('mixed', 'mixed across engines', 1, []),
        mixedSecondEngine,
      ],
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);
  const result = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.deepEqual(
    result.prompts_brand_only.map((item) => item.prompt).sort(),
    ['brand-only prompt', 'mixed across engines'],
  );
  assert.deepEqual(
    result.prompts_co_mentioned.map((item) => item.prompt).sort(),
    ['mixed across engines', 'shared prompt'],
  );
  assert.deepEqual(
    result.prompts_co_mentioned.find((item) => item.prompt === 'mixed across engines'),
    { prompt: 'mixed across engines', you_cited_by: ['claude'], competitors_cited: ['monday.com'] },
  );
  assert.deepEqual(
    result.prompts_brand_only.find((item) => item.prompt === 'mixed across engines'),
    { prompt: 'mixed across engines', you_cited_by: ['chatgpt'], competitors_cited: [] },
  );
  assert.deepEqual(
    result.competitors.find((item) => item.domain === 'asana.com')?.prompts_won_against_you,
    ['competitor-only prompt'],
  );
  assert.equal(result.prompts_you_win.length, 3);
  assert.match(result.comparison_semantics, /legacy/i);
  assert.match(result.comparison_semantics, /co-mention/i);
});


test('compare_competitors normalizes explicit competitor URL inputs before matching', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') {
        comparison = { handler: handler as ComparisonTool['handler'] };
      }
    },
  } as unknown as McpServer;

  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getResponsesSince: async () => [
        response('url', 'best project tools', 0, ['asana.com']),
      ],
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  assert.ok(comparison, 'compare_competitors tool registration missing');
  const result = await comparison.handler({
    brand_id: brand.id,
    days: 7,
    competitor_domains: ['https://www.Asana.com/pricing'],
  });

  assert.equal(result.structuredContent.competitors.length, 1);
  assert.equal(result.structuredContent.competitors[0].domain, 'asana.com');
  assert.equal(result.structuredContent.competitors[0].mentions, 1);
  assert.equal(result.structuredContent.competitors[0].share_of_voice_pct, 100);
  assert.deepEqual(result.structuredContent.outside_current_tracking, []);
});

test('comparison flags newly selected competitors whose historical capture cannot be verified', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') {
        comparison = { handler: handler as ComparisonTool['handler'] };
      }
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getResponsesSince: async () => [
        response('brand', 'best workflow software', 1, ['asana.com']),
      ],
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);
  const result = (await comparison.handler({
    brand_id: brand.id,
    competitor_domains: ['https://NEW.example.com/products', 'asana.com'],
  })).structuredContent;
  assert.deepEqual(result.outside_current_tracking, ['new.example.com']);
  assert.equal(result.competitors.find((c) => c.domain === 'new.example.com')?.mentions, 0);
  assert.match(result.historical_coverage_note, /not that it was absent/);
});

test('comparison prompt rankings remain stable when equal evidence arrives in another row order', async () => {
  const rows = [
    response('z', 'Zulu question', 1, []),
    response('a', 'Alpha question', 1, []),
    response('b', 'Beta question', 1, []),
    response('c', 'Charlie competitor question', 0, ['asana.com']),
    response('d', 'Bravo competitor question', 0, ['asana.com']),
  ];
  async function compare(source: PromptResponse[]): Promise<ComparisonResult> {
    let comparison: ComparisonTool | undefined;
    const server = {
      registerTool(name: string, _config: unknown, handler: unknown) {
        if (name === 'compare_competitors') {
          comparison = { handler: handler as ComparisonTool['handler'] };
        }
      },
    } as unknown as McpServer;
    registerTools(server, {
      db: {
        getBrand: async () => brand,
        getResponsesSince: async () => source,
      } as Db,
      env: {},
      refreshExecution: 'sync',
      runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
    });
    assert.ok(comparison);
    return (await comparison.handler({ brand_id: brand.id })).structuredContent;
  }

  const first = await compare(rows);
  const reversed = await compare([...rows].reverse());
  assert.deepEqual(first.prompts_brand_only, reversed.prompts_brand_only);
  assert.deepEqual(first.prompts_you_win, reversed.prompts_you_win);
  assert.deepEqual(
    first.prompts_brand_only.map((item) => item.prompt),
    ['Alpha question', 'Beta question', 'Zulu question'],
  );
  assert.deepEqual(
    first.competitors[0].prompts_won_against_you,
    reversed.competitors[0].prompts_won_against_you,
  );
  assert.deepEqual(first.competitors[0].prompts_won_against_you, [
    'Bravo competitor question',
    'Charlie competitor question',
  ]);
});

test('comparison distinguishes no successful observations from observed zero mentions', async () => {
  let comparison: ComparisonTool | undefined;
  let rows: PromptResponse[] = [];
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') comparison = { handler: handler as ComparisonTool['handler'] };
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getResponsesSince: async () => rows,
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);

  const missing = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(missing.your_share_of_voice_pct, 0);
  assert.equal(missing.observation_coverage.status, 'no_observations');
  assert.equal(missing.observation_coverage.successful_responses, 0);
  assert.deepEqual(missing.observation_coverage.per_engine, []);
  assert.match(missing.observation_coverage.note, /not measured|no usable/i);

  rows = [response('no-mentions', 'independent buyer question', 0, [])];
  const observed = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(observed.your_share_of_voice_pct, 0);
  assert.equal(observed.observation_coverage.status, 'observed');
  assert.equal(observed.observation_coverage.successful_responses, 1);
  assert.equal(observed.observation_coverage.per_engine[0]?.engine, 'chatgpt');
  assert.equal(observed.observation_coverage.per_engine[0]?.distinct_prompts, 1);
  assert.match(observed.observation_coverage.note, /successful response/i);
});

test('comparison with no configured competitors does not pretend observations were queried', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') comparison = { handler: handler as ComparisonTool['handler'] };
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => ({ ...brand, competitors: [] }),
      getResponsesSince: async () => { throw new Error('Must not query responses without comparison targets'); },
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);
  const result = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.observation_coverage.status, 'not_compared');
  assert.equal(result.observation_coverage.successful_responses, 0);
  assert.deepEqual(result.observation_coverage.per_engine, []);
  assert.match(result.observation_coverage.note, /competitor/i);
});

test('comparison respects an explicitly empty competitor selection', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') comparison = { handler: handler as ComparisonTool['handler'] };
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getResponsesSince: async () => { throw new Error('Explicitly empty selection must not query response evidence'); },
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);

  const result = (await comparison.handler({ brand_id: brand.id, competitor_domains: [] })).structuredContent;
  assert.equal(result.observation_coverage.status, 'not_compared');
  assert.equal(result.observation_coverage.successful_responses, 0);
  assert.deepEqual(result.observation_coverage.per_engine, []);
  assert.deepEqual(result.competitors, []);
  assert.deepEqual(result.requested_competitor_domains, []);
});

test('comparison can restrict its measurement cohort to currently active prompts', async () => {
  let comparison: ComparisonTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'compare_competitors') comparison = { handler: handler as ComparisonTool['handler'] };
    },
  } as unknown as McpServer;
  const rows = [
    { ...response('retired', 'old buyer question', 1, []), prompt_id: 'retired' },
    { ...response('active', 'new buyer question', 0, ['asana.com']), prompt_id: 'active' },
  ];
  let activePromptReads = 0;
  let selectedPromptIds = ['active'];
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getActivePrompts: async () => {
        activePromptReads++;
        return selectedPromptIds.map((id) => ({ id }));
      },
      getResponsesSince: async () => rows,
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(comparison);

  const full = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(full.your_mentions, 1);
  assert.equal(full.observation_coverage.successful_responses, 2);
  assert.equal(full.prompt_set_scope.selection, 'full_window');
  assert.equal(full.prompt_set_scope.active_prompt_count, null);
  assert.equal(activePromptReads, 0, 'default history must not query the active roster');

  const current = (await comparison.handler({ brand_id: brand.id, active_prompts_only: true })).structuredContent;
  assert.equal(current.your_mentions, 0);
  assert.equal(current.competitors[0]?.mentions, 1);
  assert.equal(current.observation_coverage.successful_responses, 1);
  assert.deepEqual(current.prompts_you_win, []);
  assert.equal(current.prompt_set_scope.selection, 'active_only');
  assert.equal(current.prompt_set_scope.active_prompt_count, 1);
  assert.equal(current.prompt_set_scope.excluded_observations, 1);
  assert.equal(activePromptReads, 1);
  assert.match(current.prompt_set_scope.note, /historical|retired/i);

  selectedPromptIds = [];
  const empty = (await comparison.handler({ brand_id: brand.id, active_prompts_only: true })).structuredContent;
  assert.equal(empty.observation_coverage.status, 'no_observations');
  assert.equal(empty.prompt_set_scope.active_prompt_count, 0);
  assert.equal(empty.prompt_set_scope.excluded_observations, 2);
  assert.equal(empty.your_mentions, 0);
});
