import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  analyzeContentGaps,
  buildFallbackRecommendations,
} from '../../src/core/content-gap-analysis.ts';
import { registerTools } from '../../src/core/tools.ts';
import type { Brand, Db, PromptResponse } from '../../src/db/types.ts';

test('fallback recommendations stay grounded in observed losing prompts', () => {
  const recommendations = buildFallbackRecommendations(
    [
      {
        prompt_text: 'Acme vs Asana for agencies',
        engines_lost_on: ['claude', 'chatgpt'],
        competitors_winning: ['asana.com', 'monday.com'],
      },
      {
        prompt_text: 'Acme pricing for small teams',
        engines_lost_on: ['perplexity'],
        competitors_winning: ['asana.com'],
      },
    ],
    2,
  );

  assert.equal(recommendations.length, 2);
  assert.equal(recommendations[0].priority, 1);
  assert.equal(recommendations[0].suggested_format, 'comparison_page');
  assert.match(recommendations[0].topic, /Acme vs Asana for agencies/);
  assert.match(recommendations[0].rationale, /chatgpt, claude/);
  assert.match(recommendations[0].rationale, /asana\.com, monday\.com/);

  assert.equal(recommendations[1].priority, 2);
  assert.equal(recommendations[1].suggested_format, 'pricing_page');
  assert.match(recommendations[1].rationale, /Acme pricing for small teams/);
  assert.match(recommendations[1].rationale, /perplexity/);
});

test('fallback recommendations rank stronger observed losses first and respect the limit', () => {
  const recommendations = buildFallbackRecommendations(
    [
      {
        prompt_text: 'How to configure Acme',
        engines_lost_on: ['chatgpt'],
        competitors_winning: ['alpha.com'],
      },
      {
        prompt_text: 'Best workflow tools',
        engines_lost_on: ['chatgpt', 'claude'],
        competitors_winning: ['alpha.com', 'beta.com', 'gamma.com'],
      },
      {
        prompt_text: 'Does Acme support SSO?',
        engines_lost_on: ['gemini'],
        competitors_winning: ['beta.com'],
      },
    ],
    2,
  );

  assert.equal(recommendations.length, 2);
  assert.match(recommendations[0].topic, /Best workflow tools/);
  assert.equal(recommendations[0].suggested_format, 'listicle');
  assert.match(recommendations[1].topic, /Does Acme support SSO/);
  assert.equal(recommendations[1].suggested_format, 'faq_page');
});

test('content gaps distinguishes missing scan evidence from observed absence of competitor wins', async () => {
  const trackedBrand: Brand = {
    id: 'acme', user_id: 'test-user', domain: 'acme.com', name: 'Acme',
    category: 'Software', competitors: ['rival.com'], aliases: [],
    exclude_terms: [], refresh_frequency: 'weekly', created_at: 0, updated_at: 0,
  };
  let haveRun = false;
  let responseStatus: 'ok' | 'error' = 'ok';
  let handler: ((args: { brand_id: string; max_recommendations: number }) => Promise<{
    structuredContent: { recommendations: unknown[]; reason?: string };
  }>) | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: unknown) {
      if (name === 'get_content_gaps') handler = callback as typeof handler;
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => trackedBrand,
      getActivePrompts: async () => [{ id: 'prompt-1' }],
      getLatestCompletedRun: async (_id, engine) =>
        haveRun && engine === 'chatgpt' ? { id: 'run-1' } : null,
      getResponsesForRun: async () => [{
        id: 'response-1', run_id: 'run-1', prompt_id: 'prompt-1',
        prompt_text: 'Best software for agencies', engine: 'chatgpt',
        raw_response: '', brand_mentioned: responseStatus === 'ok' ? 1 : 0,
        brand_cited_with_link: 0, cited_urls: [],
        competitors_mentioned: responseStatus === 'ok' ? [] : ['rival.com'],
        engine_citations: [], status: responseStatus,
        error_message: responseStatus === 'ok' ? null : 'provider failed', captured_at: 1000,
      } satisfies PromptResponse],
    } as Db,
    env: {}, refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(handler);
  const absent = (await handler({ brand_id: 'acme', max_recommendations: 3 })).structuredContent;
  assert.equal(absent.recommendations.length, 0);
  assert.match(absent.reason ?? '', /no usable scan responses/i);

  haveRun = true;
  const observed = (await handler({ brand_id: 'acme', max_recommendations: 3 })).structuredContent;
  assert.equal(observed.recommendations.length, 0);
  assert.match(observed.reason ?? '', /no competitor-only wins observed/i);
  assert.doesNotMatch(observed.reason ?? '', /collect more data first/i);

  responseStatus = 'error';
  const failed = (await handler({ brand_id: 'acme', max_recommendations: 3 })).structuredContent;
  assert.equal(failed.recommendations.length, 0);
  assert.match(failed.reason ?? '', /no usable scan responses/i);
});

test('content-gap candidate limit does not depend on database response order for tied losses', async () => {
  const brand: Brand = {
    id: 'acme',
    user_id: 'test-user',
    domain: 'acme.com',
    name: 'Acme',
    category: 'Project management',
    competitors: ['rival.com'],
    aliases: [],
    exclude_terms: [],
    refresh_frequency: 'weekly',
    created_at: 0,
    updated_at: 0,
  };
  const responses: PromptResponse[] = Array.from({ length: 16 }, (_, index) => {
    const id = String(index).padStart(2, '0');
    return {
      id: `response-${id}`,
      run_id: 'run-1',
      prompt_id: `prompt-${id}`,
      prompt_text: `Buyer question ${id}`,
      engine: 'chatgpt',
      raw_response: '',
      brand_mentioned: 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: ['rival.com'],
      engine_citations: [],
      status: 'ok',
      error_message: null,
      captured_at: 1000,
    };
  });
  let reversed = false;
  let handler: ((input: {
    brand_id: string;
    max_recommendations: number;
    ai_analysis?: boolean;
  }) => Promise<{ structuredContent: {
    recommendations: Array<{ topic: string }>;
  } }>) | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: unknown) {
      if (name === 'get_content_gaps') handler = callback as typeof handler;
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getActivePrompts: async () => responses.map((r) => ({ id: r.prompt_id })),
      getLatestCompletedRun: async (_id, engine) =>
        engine === 'chatgpt' ? { id: 'run-1' } : null,
      getResponsesForRun: async () => reversed ? [...responses].reverse() : responses,
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(handler);

  const request = { brand_id: 'acme', max_recommendations: 5 };
  const forward = (await handler(request)).structuredContent.recommendations.map((r) => r.topic);
  reversed = true;
  const backward = (await handler(request)).structuredContent.recommendations.map((r) => r.topic);
  assert.deepEqual(backward, forward);
  assert.deepEqual(
    forward,
    Array.from({ length: 5 }, (_, i) => `Address losing prompt: "Buyer question ${String(i).padStart(2, '0')}"`),
  );
});

test('content gaps use only the latest successful observation per engine and prompt', async () => {
  const brand = {
    id: 'acme', name: 'Acme', domain: 'acme.com',
    competitors: ['rival.com'], aliases: [], exclude_terms: [],
  } as Brand;
  const row = (overrides: Partial<PromptResponse>): PromptResponse => ({
    id: 'observation-a', run_id: 'run-1', prompt_id: 'outdated-loss',
    prompt_text: 'Best software for agencies', engine: 'chatgpt',
    raw_response: '', brand_mentioned: 0, brand_cited_with_link: 0,
    cited_urls: [], competitors_mentioned: ['rival.com'], engine_citations: [],
    status: 'ok', error_message: null, captured_at: 1000,
    ...overrides,
  });
  const responses: PromptResponse[] = [
    row({ id: 'outdated-a', prompt_id: 'outdated-loss', captured_at: 1000 }),
    row({ id: 'current-z', prompt_id: 'outdated-loss', captured_at: 2000,
      brand_mentioned: 1, competitors_mentioned: [] }),
    row({ id: 'old-win', prompt_id: 'current-loss', prompt_text: 'Best tools for designers',
      captured_at: 1000, brand_mentioned: 1, competitors_mentioned: [] }),
    row({ id: 'new-loss', prompt_id: 'current-loss', prompt_text: 'Best tools for designers',
      captured_at: 2000 }),
    row({ id: 'tie-a', prompt_id: 'tied', prompt_text: 'Best tools for founders',
      captured_at: 3000 }),
    row({ id: 'tie-z', prompt_id: 'tied', prompt_text: 'Best tools for founders',
      captured_at: 3000, brand_mentioned: 1, competitors_mentioned: [] }),
    row({ id: 'failed', prompt_id: 'failed', prompt_text: 'Best tools for teams',
      status: 'failed', captured_at: 4000 }),
  ];
  let handler: ((input: {
    brand_id: string; max_recommendations: number; ai_analysis: boolean;
  }) => Promise<{ structuredContent: { recommendations: Array<{ topic: string }> } }>) | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: unknown) {
      if (name === 'get_content_gaps') handler = callback as typeof handler;
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getActivePrompts: async () => responses.map((r) => ({ id: r.prompt_id })),
      getLatestCompletedRun: async (_id, engine) => engine === 'chatgpt' ? { id: 'run-1' } : null,
      getResponsesForRun: async () => responses,
    } as Db,
    env: {}, refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(handler);
  const result = await handler({ brand_id: 'acme', max_recommendations: 5, ai_analysis: false });
  assert.deepEqual(
    result.structuredContent.recommendations.map((recommendation) => recommendation.topic),
    ['Address losing prompt: "Best tools for designers"'],
    'resolved, tied and failed observations must not manufacture current losses',
  );
});


test('content gaps exclude competitors removed from current brand tracking', async () => {
  const brand: Brand = {
    id: 'acme', user_id: 'test-user', domain: 'acme.com', name: 'Acme',
    category: 'Project management', competitors: ['current.com'],
    aliases: [], exclude_terms: [], refresh_frequency: 'weekly',
    created_at: 0, updated_at: 0,
  };
  const response = (id: string, competitors: string[]): PromptResponse => ({
    id, run_id: 'run-1', prompt_id: id, prompt_text: `Question ${id}`,
    engine: 'chatgpt', raw_response: '', brand_mentioned: 0,
    brand_cited_with_link: 0, cited_urls: [], competitors_mentioned: competitors,
    engine_citations: [], status: 'ok', error_message: null, captured_at: 1000,
  });
  let responses = [
    response('retired-only', ['removed.com']),
    response('mixed', ['removed.com', 'current.com']),
  ];
  let handler: ((input: { brand_id: string; max_recommendations: number }) => Promise<{
    structuredContent: { recommendations: Array<{ topic: string; rationale: string }> };
  }>) | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: unknown) {
      if (name === 'get_content_gaps') handler = callback as typeof handler;
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getActivePrompts: async () => responses.map((r) => ({ id: r.prompt_id })),
      getLatestCompletedRun: async (_id, engine) => engine === 'chatgpt' ? { id: 'run-1' } : null,
      getResponsesForRun: async () => responses,
    } as Db,
    env: {}, refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(handler);

  const result = (await handler({ brand_id: brand.id, max_recommendations: 5 })).structuredContent;
  assert.equal(result.recommendations.length, 1);
  assert.match(result.recommendations[0].topic, /Question mixed/);
  assert.match(result.recommendations[0].rationale, /current\.com/);
  assert.doesNotMatch(result.recommendations[0].rationale, /removed\.com/);

  responses = [response('retired-only', ['removed.com'])];
  assert.deepEqual((await handler({ brand_id: brand.id, max_recommendations: 5 }))
    .structuredContent.recommendations, []);
});

test('content gaps require an explicit opt-in before any paid Anthropic call', async () => {
  const brand: Brand = {
    id: 'acme',
    user_id: 'test-user',
    domain: 'acme.com',
    name: 'Acme',
    category: 'Project management',
    competitors: ['asana.com'],
    aliases: [],
    exclude_terms: [],
    refresh_frequency: 'weekly',
    created_at: 0,
    updated_at: 0,
  };
  const response: PromptResponse = {
    id: 'response-1',
    run_id: 'run-1',
    prompt_id: 'prompt-1',
    prompt_text: 'Best project management for agencies',
    engine: 'chatgpt',
    raw_response: '',
    brand_mentioned: 0,
    brand_cited_with_link: 0,
    cited_urls: [],
    competitors_mentioned: ['asana.com'],
    engine_citations: [],
    status: 'ok',
    error_message: null,
    captured_at: Date.now(),
  };
  let includeResponses = true;
  const env = { ANTHROPIC_API_KEY: 'fake-test-key' };
  type GapResult = {
    structuredContent: {
      prompt_source: 'generated' | 'fallback';
      recommendations: Array<{ topic: string }>;
      reason?: string;
    };
  };
  let handler: ((input: {
    brand_id: string;
    max_recommendations: number;
    ai_analysis?: boolean;
  }) => Promise<GapResult>) | undefined;
  let schema: {
    ai_analysis: { parse: (value: unknown) => boolean };
    max_recommendations: { parse: (value: unknown) => number };
  } | undefined;
  const server = {
    registerTool(
      name: string,
      config: { inputSchema?: typeof schema },
      callback: unknown,
    ) {
      if (name === 'get_content_gaps') {
        handler = callback as typeof handler;
        schema = config.inputSchema;
      }
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getActivePrompts: async () => [{ id: response.prompt_id }],
      getLatestCompletedRun: async (_id, engine) =>
        engine === 'chatgpt' ? { id: 'run-1' } : null,
      getResponsesForRun: async () => includeResponses ? [response] : [],
    } as Db,
    env,
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(handler);
  assert.ok(schema);
  assert.equal(schema.ai_analysis.parse(undefined), false);
  assert.equal(schema.ai_analysis.parse(true), true);
  assert.equal(schema.max_recommendations.parse(undefined), 5);
  assert.equal(schema.max_recommendations.parse(3), 3);
  assert.throws(
    () => schema.max_recommendations.parse(2.5),
    'fractional limits must be rejected before a token-billed analysis',
  );

  const originalFetch = globalThis.fetch;
  let calls = 0;
  let rejectWithNull = false;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.match(String(input), /api\.anthropic\.com/);
    if (rejectWithNull) throw null;
    return Response.json({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify([{
        priority: 1,
        topic: 'Comparison page: Acme vs Asana',
        rationale: 'Answer the observed agencies question',
        suggested_format: 'comparison_page',
      }]) }],
    });
  };
  try {
    const defaultResult = await handler({ brand_id: 'acme', max_recommendations: 3 });
    assert.equal(defaultResult.structuredContent.prompt_source, 'fallback');
    assert.equal(defaultResult.structuredContent.recommendations.length, 1);
    assert.equal(defaultResult.structuredContent.reason, undefined,
      'provider-free default is expected behavior, not an analyzer failure');
    assert.equal(calls, 0, 'configured API key must not trigger a paid call without opt-in');

    const explicitResult = await handler({
      brand_id: 'acme',
      max_recommendations: 3,
      ai_analysis: true,
    });
    assert.equal(explicitResult.structuredContent.prompt_source, 'generated');
    assert.equal(explicitResult.structuredContent.reason, undefined);
    assert.equal(calls, 1, 'explicit paid analysis should make one successful call');

    rejectWithNull = true;
    const failedResult = await handler({
      brand_id: 'acme', max_recommendations: 3, ai_analysis: true,
    });
    assert.equal(failedResult.structuredContent.prompt_source, 'fallback');
    assert.equal(failedResult.structuredContent.recommendations.length, 1);
    assert.match(failedResult.structuredContent.reason ?? '', /requested.*failed.*provider-free/i);
    assert.match(failedResult.structuredContent.reason ?? '', /bill/i,
      'failed paid requests can still incur provider usage');
    assert.equal(calls, 2, 'failed provider requests must not be retried for formatting');

    env.ANTHROPIC_API_KEY = '  \t  ';
    const blankKeyResult = await handler({
      brand_id: 'acme', max_recommendations: 3, ai_analysis: true,
    });
    assert.equal(blankKeyResult.structuredContent.prompt_source, 'fallback');
    assert.match(blankKeyResult.structuredContent.reason ?? '', /requested.*ANTHROPIC_API_KEY.*not configured/i);
    assert.equal(calls, 2, 'whitespace-only credentials must never reach a provider');

    includeResponses = false;
    env.ANTHROPIC_API_KEY = 'fake-test-key';
    const noEvidence = await handler({
      brand_id: 'acme', max_recommendations: 3, ai_analysis: true,
    });
    assert.equal(noEvidence.structuredContent.prompt_source, 'fallback',
      'no evidence must not be represented as generated recommendations');
    assert.equal(noEvidence.structuredContent.recommendations.length, 0);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('content-gap analyzer does not repeat a failed paid provider request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ error: { message: 'rate limited' } }, { status: 429 });
  };
  try {
    await assert.rejects(
      analyzeContentGaps(
        { ANTHROPIC_API_KEY: 'fake-test-key' },
        { id: 'acme', name: 'Acme', domain: 'acme.com' } as Brand,
        [{
          prompt_text: 'Acme vs Asana for agencies',
          engines_lost_on: ['chatgpt'],
          competitors_winning: ['asana.com'],
        }],
        1,
      ),
      /Anthropic completion failed: 429/,
    );
    assert.equal(calls, 1, 'provider HTTP failures should not trigger a paid strict-format retry');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('content-gap analyzer still retries malformed model output once', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      stop_reason: 'end_turn',
      content: [{
        type: 'text',
        text: calls === 1
          ? 'not valid JSON'
          : JSON.stringify([{
            priority: 1,
            topic: 'Compare Acme with Asana',
            rationale: 'The observed buyer question mentions Asana',
            suggested_format: 'comparison_page',
          }]),
      }],
    });
  };
  try {
    const result = await analyzeContentGaps(
      { ANTHROPIC_API_KEY: 'fake-test-key' },
      { id: 'acme', name: 'Acme', domain: 'acme.com' } as Brand,
      [{
        prompt_text: 'Acme vs Asana for agencies',
        engines_lost_on: ['chatgpt'],
        competitors_winning: ['asana.com'],
      }],
      1,
    );
    assert.equal(calls, 2);
    assert.equal(result[0]?.topic, 'Compare Acme with Asana');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('content-gap analyzer rejects whitespace-only Anthropic credentials before requests', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response('invalid key', { status: 401 });
  };
  try {
    await assert.rejects(
      analyzeContentGaps(
        { ANTHROPIC_API_KEY: ' \n ' },
        { id: 'acme', name: 'Acme', domain: 'acme.com' } as Brand,
        [{ prompt_text: 'Best agency tools', engines_lost_on: ['chatgpt'], competitors_winning: ['rival.com'] }],
        1,
      ),
      /ANTHROPIC_API_KEY not set/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('content-gap advice discloses US/English Google sampling only for observed losing engines', async () => {
  const brand: Brand = {
    id: 'acme', user_id: 'test-user', name: 'Acme', domain: 'acme.com',
    category: 'Software', competitors: ['rival.com'], aliases: [],
    exclude_terms: [], refresh_frequency: 'weekly', created_at: 0, updated_at: 0,
  };
  const response = (engine: string): PromptResponse => ({
    id: 'response-1', run_id: 'run-1', prompt_id: 'prompt-1',
    prompt_text: 'Best software for agencies', engine,
    raw_response: '', brand_mentioned: 0, brand_cited_with_link: 0,
    cited_urls: [], competitors_mentioned: ['rival.com'], engine_citations: [],
    status: 'ok', error_message: null, captured_at: 1000,
  });
  let observedEngine = 'ai_overviews';
  let handler: ((input: { brand_id: string; max_recommendations: number }) => Promise<{
    structuredContent: { google_search_sampling: null | {
      engines: string[]; country: string; language: string; scope_note: string;
    } };
  }>) | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: unknown) {
      if (name === 'get_content_gaps') handler = callback as typeof handler;
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getActivePrompts: async () => [{ id: 'prompt-1' }],
      getLatestCompletedRun: async (_id, engine) =>
        engine === observedEngine ? { id: 'run-1' } : null,
      getResponsesForRun: async () => [response(observedEngine)],
    } as Db,
    env: {}, refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(handler);
  const google = (await handler({ brand_id: 'acme', max_recommendations: 1 }))
    .structuredContent.google_search_sampling;
  assert.deepEqual(google?.engines, ['ai_overviews']);
  assert.equal(google?.country, 'us');
  assert.equal(google?.language, 'en');
  assert.match(google?.scope_note ?? '', /US location/);

  observedEngine = 'chatgpt';
  const nonGoogle = (await handler({ brand_id: 'acme', max_recommendations: 1 }))
    .structuredContent.google_search_sampling;
  assert.equal(nonGoogle, null);
});

test('content gaps never recommend prompts retired from the active buyer-intent set', async () => {
  const brand = {
    id: 'acme', name: 'Acme', domain: 'acme.com', competitors: ['rival.com'],
    aliases: [], exclude_terms: [],
  } as Brand;
  const response = (promptId: string): PromptResponse => ({
    id: `response-${promptId}`, run_id: 'run-1', prompt_id: promptId,
    prompt_text: `Question for ${promptId}`, engine: 'chatgpt', raw_response: '',
    brand_mentioned: 0, brand_cited_with_link: 0, cited_urls: [],
    competitors_mentioned: ['rival.com'], engine_citations: [], status: 'ok',
    error_message: null, captured_at: 1000,
  });
  let responses = [response('retired')];
  let handler: ((input: { brand_id: string; max_recommendations: number }) => Promise<{
    structuredContent: { recommendations: Array<{ topic: string }>; reason?: string };
  }>) | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: unknown) {
      if (name === 'get_content_gaps') handler = callback as typeof handler;
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getActivePrompts: async () => [{ id: 'active' }],
      getLatestCompletedRun: async (_id, engine) => engine === 'chatgpt' ? { id: 'run-1' } : null,
      getResponsesForRun: async () => responses,
    } as Db,
    env: {}, refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  assert.ok(handler);

  const retiredOnly = (await handler({ brand_id: 'acme', max_recommendations: 5 })).structuredContent;
  assert.deepEqual(retiredOnly.recommendations, []);
  assert.match(retiredOnly.reason ?? '', /current(ly)? active prompts/i);

  responses = [response('retired'), response('active')];
  const mixed = (await handler({ brand_id: 'acme', max_recommendations: 5 })).structuredContent;
  assert.deepEqual(mixed.recommendations.map((item) => item.topic), [
    'Address losing prompt: "Question for active"',
  ]);
});
