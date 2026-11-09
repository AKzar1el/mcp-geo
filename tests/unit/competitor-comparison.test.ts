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
  }) => Promise<{ structuredContent: ComparisonResult }>;
};

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
  assert.equal(result.your_mentions, 2);
  assert.equal(result.your_share_of_voice_pct, 50);
  assert.equal(result.competitors.find((c) => c.domain === 'asana.com')?.mentions, 1);
  assert.equal(result.competitors.find((c) => c.domain === 'monday.com')?.mentions, 1);
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
  assert.match(missing.observation_coverage.note, /not measured|no usable/i);

  rows = [response('no-mentions', 'independent buyer question', 0, [])];
  const observed = (await comparison.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(observed.your_share_of_voice_pct, 0);
  assert.equal(observed.observation_coverage.status, 'observed');
  assert.equal(observed.observation_coverage.successful_responses, 1);
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
  assert.match(result.observation_coverage.note, /competitor/i);
});
