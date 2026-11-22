import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type {
  Brand,
  CitationRow,
  Db,
  Prompt,
  PromptResponse,
} from '../../src/db/types.ts';

type SourceFixture = PromptResponse & { mode?: 'live' | 'batch'; run_started_at?: number | null };

const brand: Brand = {
  id: 'acme',
  user_id: 'test-user',
  domain: 'acme.com',
  name: 'Acme',
  category: 'Project management',
  competitors: [],
  aliases: [],
  exclude_terms: [],
  refresh_frequency: 'weekly',
  created_at: 0,
  updated_at: 0,
};

type CitationResult = {
  has_more: boolean;
  next_cursor: string | null;
  limit: number;
  total_matching_rows: number;
  top_sources_limit: number;
  total_source_domains: number;
  top_sources_truncated: boolean;
  measurement_mode_filter: 'model_only' | 'search_requested' | null;
  engine_scope: {
    selection: 'selected' | 'all_stored';
    requested_engines: string[];
    not_observed_engines: string[];
    note: string;
  };
  observation_coverage: {
    per_engine: Array<{
      engine: string;
      successful_observation_count: number;
      distinct_prompt_count: number;
      last_observed_at: string | null;
    }>;
    note: string;
  };
  google_search_sampling: null | {
    engines: string[];
    country: 'us';
    language: 'en';
    scope_note: string;
  };
  top_sources: Array<{
    domain: string;
    citation_count: number;
    per_engine_citation_count: Record<string, number>;
    per_engine_source_observation_percent: Record<string, number>;
    per_engine_distinct_prompt_count: Record<string, number>;
    per_engine_last_observed_at: Record<string, string>;
    per_engine_examples: Record<string, { sample_url: string; url_redacted: boolean; run_id: string; response_id: string }>;
    distinct_cited_path_count: number;
    top_cited_paths: Array<{ path: string; response_count: number }>;
    prompt_count: number;
    last_observed_at: string;
    engines: string[];
    measurement_modes: Array<'model_only' | 'search_requested'>;
    sample_url: string;
    url_redacted: boolean;
    is_brand_domain: boolean;
    identity_scopes?: Array<'current' | 'historical' | 'unattributed'>;
  }>;
  identity_attribution: null | { identity_changed_at: string; note: string };
  identity_filter: {
    selection: 'full_history' | 'current_identity_only';
    applied: boolean;
    note: string;
  };
  prompt_set_scope: {
    selection: 'full_history' | 'active_only';
    active_prompt_count: number | null;
    note: string;
  };
  citations: Array<{
    id: string;
    run_id: string;
    response_id: string;
    prompt: string;
    cited_url: string | null;
    url_redacted: boolean;
    citation_type: string;
    url_source: 'provider_source' | 'answer_text' | null;
    measurement_mode: 'model_only' | 'search_requested';
    identity_scope?: 'current' | 'historical' | 'unattributed';
  }>;
};

type CitationTool = {
  handler: (args: {
    brand_id: string;
    days?: number;
    engine?: 'chatgpt' | 'claude' | 'perplexity' | 'gemini' | 'ai_overviews' | 'ai_mode';
    engines?: Array<'chatgpt' | 'claude' | 'perplexity' | 'gemini' | 'ai_overviews' | 'ai_mode'>;
    limit?: number;
    top_sources_limit?: number;
    cursor?: string;
    current_identity_only?: boolean;
    active_prompts_only?: boolean;
    measurement_mode?: 'model_only' | 'search_requested';
  }) => Promise<{ structuredContent: CitationResult }>;
};

function registerCitationTool(
  row: CitationRow | CitationRow[],
  responses: SourceFixture[] = [],
  trackedBrand: Brand = brand,
  activeIds: string[] = [],
): CitationTool {
  let citationTool: CitationTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'get_citations') {
        citationTool = { handler: handler as CitationTool['handler'] };
      }
    },
  } as unknown as McpServer;

  registerTools(server, {
    db: {
      getBrand: async () => trackedBrand,
      getActivePrompts: async () => activeIds.map((id): Prompt => ({
        id, brand_id: trackedBrand.id, text: id, intent_stage: null,
        shape: null, active: 1, created_at: 0,
      })),
      countCitationRows: async (_brandId, _since, engine, page) =>
        (Array.isArray(row) ? row : [row])
          .filter((item) => !engine ||
            (Array.isArray(engine) ? engine.length === 0 || engine.includes(item.engine) : item.engine === engine))
          .filter((item) => !page?.measurementMode ||
            ((item.mode === 'batch' || item.engine === 'claude' || item.engine === 'gemini'
              ? 'model_only' : 'search_requested') === page.measurementMode))
          .filter((item) => item.captured_at <= (page?.until ?? Number.MAX_SAFE_INTEGER))
          .filter((item) => page?.minRunStartedAt === undefined ||
            (typeof item.run_started_at === 'number' && item.run_started_at >= page.minRunStartedAt))
          .filter((item) => !page?.activePromptsOnly || activeIds.includes(item.prompt_id)).length,
      getCitationRows: async (_brandId, _since, engine, page) => {
        const rows = (Array.isArray(row) ? row : [row])
          .filter((item) => !engine ||
            (Array.isArray(engine) ? engine.length === 0 || engine.includes(item.engine) : item.engine === engine))
          .filter((item) => !page?.measurementMode ||
            ((item.mode === 'batch' || item.engine === 'claude' || item.engine === 'gemini'
              ? 'model_only' : 'search_requested') === page.measurementMode))
          .filter((item) => item.captured_at <= (page?.until ?? Number.MAX_SAFE_INTEGER))
          .filter((item) => page?.minRunStartedAt === undefined ||
            (typeof item.run_started_at === 'number' && item.run_started_at >= page.minRunStartedAt))
          .filter((item) => !page?.activePromptsOnly || activeIds.includes(item.prompt_id))
          .filter((item) => !page?.before ||
            item.captured_at < page.before.captured_at ||
            (item.captured_at === page.before.captured_at &&
              (item.run_id < page.before.run_id ||
                (item.run_id === page.before.run_id &&
                  (item.prompt_id < page.before.prompt_id ||
                    (item.prompt_id === page.before.prompt_id &&
                      page.before.response_id !== undefined &&
                      item.response_id < page.before.response_id))))))
          .sort((a, b) => b.captured_at - a.captured_at ||
            b.run_id.localeCompare(a.run_id) || b.prompt_id.localeCompare(a.prompt_id) ||
            b.response_id.localeCompare(a.response_id));
        return rows.slice(0, page?.limit ?? 50);
      },
      getResponsesSince: async () => {
        throw new Error('get_citations must not hydrate full responses');
      },
      getCitationSourceRows: async (_brandId, _since, until, engine, minRunStartedAt, activeOnly, measurementMode) =>
        responses
          .filter((response) => response.captured_at <= until && (!engine ||
            (Array.isArray(engine) ? engine.length === 0 || engine.includes(response.engine) : response.engine === engine)))
          .filter((response) => !measurementMode ||
            ((response.mode === 'batch' || response.engine === 'claude' || response.engine === 'gemini'
              ? 'model_only' : 'search_requested') === measurementMode))
          .filter((response) => minRunStartedAt === undefined ||
            (typeof response.run_started_at === 'number' && response.run_started_at >= minRunStartedAt))
          .filter((response) => !activeOnly || activeIds.includes(response.prompt_id))
          .map(({ id, run_id, prompt_id, engine: responseEngine, mode, captured_at, engine_citations, run_started_at }) => ({
            id,
            run_id,
            prompt_id,
            engine: responseEngine,
            mode,
            captured_at,
            engine_citations,
            run_started_at,
          })),
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  assert.ok(citationTool, 'get_citations tool registration missing');
  return citationTool;
}

function promptResponse(
  overrides: Partial<SourceFixture> = {},
): SourceFixture {
  return {
    id: 'response-1',
    run_id: 'run-1',
    prompt_id: 'prompt-1',
    prompt_text: 'best project management tools',
    engine: 'chatgpt',
    raw_response: 'Example response',
    brand_mentioned: 0,
    brand_cited_with_link: 0,
    cited_urls: [],
    competitors_mentioned: [],
    engine_citations: [],
    status: 'ok',
    error_message: null,
    captured_at: Date.UTC(2026, 8, 20),
    ...overrides,
  };
}

function citationRow(overrides: Partial<CitationRow> = {}): CitationRow {
  return {
    response_id: `response-${overrides.run_id ?? 'run-1234567890'}-${overrides.prompt_id ?? 'prompt-1234567890'}`,
    engine: 'chatgpt',
    prompt: 'best project management tools',
    raw_response: 'Acme is a useful option.',
    brand_mentioned: 1,
    brand_cited_with_link: 1,
    cited_urls_json: JSON.stringify(['acme.com']),
    engine_citations_json: JSON.stringify([]),
    captured_at: Date.UTC(2026, 8, 20),
    run_id: 'run-1234567890',
    prompt_id: 'prompt-1234567890',
    ...overrides,
  };
}

test('citation rows expose the exact stored run and response for observation drilldown', async () => {
  const now = Date.now();
  const rows = [
    citationRow({ run_id: 'run-alpha', response_id: 'response-alpha', prompt_id: 'shared', captured_at: now }),
    citationRow({ run_id: 'run-beta', response_id: 'response-beta', prompt_id: 'shared', captured_at: now - 1000 }),
  ];
  const tool = registerCitationTool(rows);
  const first = (await tool.handler({ brand_id: brand.id, days: 14, limit: 1 })).structuredContent;
  assert.equal(first.citations.length, 1);
  assert.equal(first.citations[0].run_id, 'run-alpha');
  assert.equal(first.citations[0].response_id, 'response-alpha');
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor);
  const second = (await tool.handler({
    brand_id: brand.id, days: 14, limit: 1, cursor: first.next_cursor!,
  })).structuredContent;
  assert.equal(second.citations.length, 1);
  assert.equal(second.citations[0].run_id, 'run-beta');
  assert.equal(second.citations[0].response_id, 'response-beta');
  assert.equal(second.has_more, false);
});

test('citation evidence discloses Google US-English sampling even without a Google citation match', async () => {
  const tool = registerCitationTool(citationRow({ engine: 'chatgpt' }));
  const google = await tool.handler({ brand_id: brand.id, engine: 'ai_overviews' });
  assert.deepEqual(google.structuredContent.citations, []);
  assert.deepEqual(google.structuredContent.google_search_sampling?.engines, ['ai_overviews']);
  assert.equal(google.structuredContent.google_search_sampling?.country, 'us');
  assert.equal(google.structuredContent.google_search_sampling?.language, 'en');
  assert.match(google.structuredContent.google_search_sampling?.scope_note ?? '', /other markets or languages/);
  const other = await tool.handler({ brand_id: brand.id, engine: 'chatgpt' });
  assert.equal(other.structuredContent.google_search_sampling, null);
});

test('unfiltered citation evidence flags only the Google surfaces actually represented', async () => {
  const tool = registerCitationTool([
    citationRow({ engine: 'chatgpt', run_id: 'chatgpt-1' }),
    citationRow({ engine: 'ai_mode', run_id: 'google-1' }),
  ]);
  const result = await tool.handler({ brand_id: brand.id });
  assert.deepEqual(result.structuredContent.google_search_sampling?.engines, ['ai_mode']);
});

test('citation rows distinguish model-only batch and ungrounded responses from live search requests', async () => {
  const citation = registerCitationTool([
    citationRow({ run_id: 'batch', prompt: 'Batch response', engine: 'chatgpt', mode: 'batch' }),
    citationRow({ run_id: 'live', prompt: 'Live response', engine: 'chatgpt', mode: 'live' }),
    citationRow({ run_id: 'claude', prompt: 'Claude response', engine: 'claude', mode: 'live' }),
    citationRow({ run_id: 'google', prompt: 'Google response', engine: 'ai_overviews', mode: 'live' }),
  ]);
  const { structuredContent } = await citation.handler({ brand_id: brand.id });
  assert.deepEqual(Object.fromEntries(structuredContent.citations.map((row) => [
    row.prompt, row.measurement_mode,
  ])), {
    'Batch response': 'model_only',
    'Live response': 'search_requested',
    'Claude response': 'model_only',
    'Google response': 'search_requested',
  });
});

test('citation request-mode selection filters before paging and source ranking and binds cursors', async () => {
  const captured_at = Date.now() - 10_000;
  const rows = [
    citationRow({ response_id: 'batch', run_id: 'batch', prompt_id: 'p1', mode: 'batch', captured_at }),
    citationRow({ response_id: 'live-1', run_id: 'live-1', prompt_id: 'p2', mode: 'live', captured_at: captured_at - 100 }),
    citationRow({ response_id: 'claude', run_id: 'claude', prompt_id: 'p3', engine: 'claude', mode: 'live', captured_at: captured_at - 200 }),
    citationRow({ response_id: 'live-2', run_id: 'live-2', prompt_id: 'p4', mode: 'live', captured_at: captured_at - 300 }),
  ];
  const sources: SourceFixture[] = [
    { ...promptResponse({ id: 'batch', run_id: 'batch', prompt_id: 'p1', captured_at, engine_citations: ['https://batch.example/report'] }), mode: 'batch' },
    { ...promptResponse({ id: 'live-1', run_id: 'live-1', prompt_id: 'p2', captured_at: captured_at - 100, engine_citations: ['https://search.example/first'] }), mode: 'live' },
    { ...promptResponse({ id: 'claude', run_id: 'claude', prompt_id: 'p3', engine: 'claude', captured_at: captured_at - 200, engine_citations: ['https://model.example/report'] }), mode: 'live' },
    { ...promptResponse({ id: 'live-2', run_id: 'live-2', prompt_id: 'p4', captured_at: captured_at - 300, engine_citations: ['https://search.example/second'] }), mode: 'live' },
  ];
  const citation = registerCitationTool(rows, sources);
  const historical = await citation.handler({ brand_id: brand.id });
  assert.equal(historical.structuredContent.citations.length, 4);
  assert.equal(historical.structuredContent.measurement_mode_filter, null);

  const search = await citation.handler({ brand_id: brand.id, measurement_mode: 'search_requested', limit: 1 });
  assert.equal(search.structuredContent.measurement_mode_filter, 'search_requested');
  assert.deepEqual(search.structuredContent.citations.map((row) => row.id), ['cit_live-1']);
  assert.equal(search.structuredContent.has_more, true);
  assert.deepEqual(search.structuredContent.top_sources.map((row) => [row.domain, row.citation_count]), [['search.example', 2]]);
  const next = await citation.handler({ brand_id: brand.id, measurement_mode: 'search_requested', limit: 1, cursor: search.structuredContent.next_cursor! });
  assert.deepEqual(next.structuredContent.citations.map((row) => row.id), ['cit_live-2']);
  assert.deepEqual(next.structuredContent.top_sources, search.structuredContent.top_sources);
  await assert.rejects(citation.handler({ brand_id: brand.id, limit: 1, cursor: search.structuredContent.next_cursor! }), /cursor/i);
  await assert.rejects(citation.handler({ brand_id: brand.id, measurement_mode: 'model_only', limit: 1, cursor: search.structuredContent.next_cursor! }), /cursor/i);

  const model = await citation.handler({ brand_id: brand.id, measurement_mode: 'model_only' });
  assert.deepEqual(model.structuredContent.citations.map((row) => row.id), ['cit_batch', 'cit_claude']);
  assert.deepEqual(model.structuredContent.top_sources.map((row) => row.domain).sort(), ['batch.example', 'model.example']);
});

test('citation evidence distinguishes old-identity scans from current scans using run start rather than capture time', async () => {
  const now = Date.now();
  const boundary = now - 10_000;
  const changedBrand: Brand = { ...brand, identity_changed_at: boundary, name: 'New Brand', domain: 'newbrand.example' };
  const rows = [
    citationRow({ response_id: 'old', run_id: 'old-run', prompt_id: 'p1', run_started_at: boundary - 1000, captured_at: now - 1000 }),
    citationRow({ response_id: 'new', run_id: 'new-run', prompt_id: 'p2', run_started_at: boundary + 1000, captured_at: now - 2000 }),
    citationRow({ response_id: 'unknown', run_id: 'unknown-run', prompt_id: 'p3', captured_at: now - 3000 }),
  ];
  const responses = [
    promptResponse({ id: 'old', run_id: 'old-run', prompt_id: 'p1', run_started_at: boundary - 1000, captured_at: now - 1000, engine_citations: ['https://research.example/old'] }),
    promptResponse({ id: 'new', run_id: 'new-run', prompt_id: 'p2', run_started_at: boundary + 1000, captured_at: now - 2000, engine_citations: ['https://research.example/new'] }),
    promptResponse({ id: 'unknown', run_id: 'unknown-run', prompt_id: 'p3', captured_at: now - 3000, engine_citations: ['https://research.example/unknown'] }),
  ];
  const result = (await registerCitationTool(rows, responses, changedBrand).handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.identity_attribution?.identity_changed_at, new Date(boundary).toISOString());
  assert.match(result.identity_attribution?.note ?? '', /historical/i);
  assert.deepEqual(Object.fromEntries(result.citations.map((row) => [row.id, row.identity_scope])), {
    cit_old: 'historical', cit_new: 'current', cit_unknown: 'unattributed',
  });
  assert.deepEqual(result.top_sources[0]?.identity_scopes, ['current', 'historical', 'unattributed']);
});

test('current-identity citation pages and top sources exclude historical and unattributed runs before LIMIT', async () => {
  const now = Date.now();
  const boundary = now - 20_000;
  const changedBrand: Brand = { ...brand, identity_changed_at: boundary };
  const records = [
    { id: 'old', run: 'old-run', started: boundary - 1000, captured: now - 1000, url: 'https://old.example/a' },
    { id: 'unknown', run: 'unknown-run', started: undefined, captured: now - 1500, url: 'https://unknown.example/b' },
    { id: 'new-1', run: 'new-1-run', started: boundary + 1000, captured: now - 2000, url: 'https://fresh.example/one' },
    { id: 'new-2', run: 'new-2-run', started: boundary + 2000, captured: now - 2000, url: 'https://fresh.example/two' },
  ];
  const tool = registerCitationTool(
    records.map(({ id, run, started, captured }) =>
      citationRow({ response_id: id, run_id: run, prompt_id: id, run_started_at: started, captured_at: captured })),
    records.map(({ id, run, started, captured, url }) =>
      promptResponse({ id, run_id: run, prompt_id: id, run_started_at: started, captured_at: captured, engine_citations: [url] })),
    changedBrand,
  );
  const full = (await tool.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(full.citations.length, 4);
  assert.equal(full.total_matching_rows, 4);
  assert.equal(full.identity_filter.selection, 'full_history');
  assert.equal(full.top_sources.length, 3);

  const first = (await tool.handler({ brand_id: brand.id, current_identity_only: true, limit: 1 })).structuredContent;
  assert.equal(first.identity_filter.selection, 'current_identity_only');
  assert.equal(first.identity_filter.applied, true);
  assert.equal(first.citations.length, 1);
  assert.equal(first.total_matching_rows, 2);
  assert.equal(first.citations[0].identity_scope, 'current');
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor);
  assert.deepEqual(first.top_sources.map(({ domain, citation_count }) => [domain, citation_count]),
    [['fresh.example', 2]]);
  const second = (await tool.handler({
    brand_id: brand.id, current_identity_only: true, limit: 1, cursor: first.next_cursor!,
  })).structuredContent;
  assert.equal(second.has_more, false);
  assert.equal(second.citations.length, 1);
  assert.equal(second.total_matching_rows, 2);
  assert.equal(second.citations[0].identity_scope, 'current');
  assert.notEqual(second.citations[0].id, first.citations[0].id);

  await assert.rejects(
    tool.handler({ brand_id: brand.id, limit: 1, cursor: first.next_cursor! }),
    /Invalid citation cursor/,
  );
  const changedAgain = registerCitationTool([], [], { ...changedBrand, identity_changed_at: boundary + 500 });
  await assert.rejects(
    changedAgain.handler({ brand_id: brand.id, current_identity_only: true, cursor: first.next_cursor! }),
    /Invalid citation cursor/,
  );
});

test('current-identity citation request without a recorded boundary discloses unfiltered evidence', async () => {
  const tool = registerCitationTool(citationRow({ response_id: 'legacy', captured_at: Date.now() - 1000 }));
  const result = (await tool.handler({ brand_id: brand.id, current_identity_only: true })).structuredContent;
  assert.equal(result.citations.length, 1);
  assert.equal(result.identity_filter.selection, 'current_identity_only');
  assert.equal(result.identity_filter.applied, false);
  assert.match(result.identity_filter.note, /no recorded.*boundary/i);
});

test('active buyer-prompt citation pages and sources exclude newer retired-prompt evidence before LIMIT', async () => {
  const now = Date.now();
  const rows = [
    citationRow({ response_id: 'retired', prompt_id: 'old-question', captured_at: now - 1000 }),
    citationRow({ response_id: 'current', prompt_id: 'new-question', captured_at: now - 2000 }),
  ];
  const sources = [
    promptResponse({ id: 'retired', prompt_id: 'old-question', captured_at: now - 1000,
      engine_citations: ['https://old.example/review'] }),
    promptResponse({ id: 'current', prompt_id: 'new-question', captured_at: now - 2000,
      engine_citations: ['https://new.example/review'] }),
  ];
  const tool = registerCitationTool(rows, sources, brand, ['new-question']);
  const historical = (await tool.handler({ brand_id: brand.id, limit: 1 })).structuredContent;
  assert.equal(historical.has_more, true);
  assert.equal(historical.total_matching_rows, 2);
  assert.equal(historical.top_sources.length, 2);
  assert.equal(historical.prompt_set_scope.selection, 'full_history');

  const active = (await tool.handler({ brand_id: brand.id, active_prompts_only: true, limit: 1 })).structuredContent;
  assert.equal(active.citations.length, 1);
  assert.equal(active.total_matching_rows, 1);
  assert.equal(active.citations[0].id, 'cit_current');
  assert.equal(active.has_more, false);
  assert.equal(active.prompt_set_scope.selection, 'active_only');
  assert.equal(active.prompt_set_scope.active_prompt_count, 1);
  assert.deepEqual(active.top_sources.map(({ domain }) => domain), ['new.example']);

  const noActive = registerCitationTool(rows, sources, brand, []);
  const empty = (await noActive.handler({ brand_id: brand.id, active_prompts_only: true })).structuredContent;
  assert.equal(empty.citations.length, 0);
  assert.equal(empty.total_matching_rows, 0);
  assert.deepEqual(empty.top_sources, []);
  assert.equal(empty.prompt_set_scope.active_prompt_count, 0);
});

test('active-prompt cursor rejects changed buyer roster and incompatible filter scope', async () => {
  const now = Date.now();
  const rows = [
    citationRow({ response_id: 'one', prompt_id: 'active-1', captured_at: now - 1000 }),
    citationRow({ response_id: 'two', prompt_id: 'active-2', captured_at: now - 2000 }),
  ];
  const tool = registerCitationTool(rows, [], brand, ['active-1', 'active-2']);
  const first = (await tool.handler({ brand_id: brand.id, active_prompts_only: true, limit: 1 })).structuredContent;
  assert.ok(first.next_cursor);
  const second = (await tool.handler({
    brand_id: brand.id, active_prompts_only: true, limit: 1, cursor: first.next_cursor!,
  })).structuredContent;
  assert.equal(second.citations.length, 1);
  assert.equal(second.has_more, false);
  await assert.rejects(
    tool.handler({ brand_id: brand.id, cursor: first.next_cursor! }), /Invalid citation cursor/,
  );
  const changed = registerCitationTool(rows, [], brand, ['active-1']);
  await assert.rejects(
    changed.handler({ brand_id: brand.id, active_prompts_only: true, cursor: first.next_cursor! }),
    /Invalid citation cursor/,
  );
});

test('get_citations produces distinct stable IDs for records sharing short UUID prefixes', async () => {
  const first = citationRow({
    run_id: '12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    prompt_id: '87654321-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    captured_at: Date.now() - 1000,
  });
  const second = citationRow({
    run_id: '12345678-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    prompt_id: '87654321-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    captured_at: Date.now() - 2000,
  });
  const tool = registerCitationTool([first, second]);
  const firstRead = await tool.handler({ brand_id: brand.id });
  const secondRead = await tool.handler({ brand_id: brand.id });
  const ids = firstRead.structuredContent.citations.map((citation) => citation.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, 'two distinct observations must never share a citation ID');
  assert.deepEqual(ids, secondRead.structuredContent.citations.map((citation) => citation.id));
});

test('repeated observations for one run and prompt have unique IDs and complete cursor pages', async () => {
  const captured_at = Date.now() - 1000;
  const first = Object.assign(citationRow({ captured_at, raw_response: 'First Acme answer.' }), {
    response_id: 'response-b',
  });
  const second = Object.assign(citationRow({ captured_at, raw_response: 'Second Acme answer.' }), {
    response_id: 'response-a',
  });
  const tool = registerCitationTool([first, second]);
  const all = await tool.handler({ brand_id: brand.id });
  assert.equal(all.structuredContent.citations.length, 2);
  assert.equal(new Set(all.structuredContent.citations.map((c) => c.id)).size, 2);

  const firstPage = await tool.handler({ brand_id: brand.id, limit: 1 });
  assert.equal(firstPage.structuredContent.has_more, true);
  assert.ok(firstPage.structuredContent.next_cursor);
  const secondPage = await tool.handler({
    brand_id: brand.id, limit: 1, cursor: firstPage.structuredContent.next_cursor!,
  });
  assert.equal(secondPage.structuredContent.citations.length, 1);
  assert.equal(secondPage.structuredContent.has_more, false);
  assert.notEqual(firstPage.structuredContent.citations[0].id, secondPage.structuredContent.citations[0].id);
});

test('get_citations preserves the full engine-native brand citation URL', async () => {
  const citation = registerCitationTool(
    citationRow({
      engine_citations_json: JSON.stringify([
        'https://www.acme.com/guides/ai-search?utm_source=chatgpt',
      ]),
    }),
  );

  const result = await citation.handler({ brand_id: brand.id });

  assert.equal(
    result.structuredContent.citations[0].cited_url,
    'https://www.acme.com/guides/ai-search?utm_source=chatgpt',
  );
  assert.equal(result.structuredContent.citations[0].url_source, 'provider_source');
});

test('get_citations never fabricates a URL from host-only evidence', async () => {
  const citation = registerCitationTool(
    citationRow({
      engine_citations_json: JSON.stringify([
        'https://example.org/reference',
        'not-a-url',
      ]),
    }),
  );

  const result = await citation.handler({ brand_id: brand.id });

  assert.equal(result.structuredContent.citations[0].cited_url, null);
  assert.equal(result.structuredContent.citations[0].url_source, null);
});

test('get_citations preserves an actual answer-authored brand URL when no native source matches', async () => {
  const citation = registerCitationTool(
    citationRow({
      raw_response: 'Compare [Acme](https://docs.acme.com/pricing?ref=answer) to rivals.',
      engine_citations_json: JSON.stringify(['https://example.org/report']),
    }),
  );
  const result = await citation.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.citations[0].cited_url, 'https://docs.acme.com/pricing?ref=answer');
  assert.equal(result.structuredContent.citations[0].url_source, 'answer_text');
});

test('credential-bearing source and answer URLs cannot become brand citation evidence', async () => {
  const citation = registerCitationTool(citationRow({
    raw_response: 'Acme appears at https://reporter:secret@acme.com/private',
    engine_citations_json: JSON.stringify(['https://user:pass@acme.com/evidence']),
  }));
  const result = await citation.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.citations[0].cited_url, null);
  assert.equal(result.structuredContent.citations[0].url_source, null);
});

test('top source samples reject credential-bearing URLs without hiding safe citations', async () => {
  const citation = registerCitationTool(citationRow(), [
    promptResponse({ engine_citations: [
      'https://reporter:secret@news.example/report',
      'https://news.example/safe-report',
      'https://user:token@elsewhere.example/article',
    ] }),
  ]);
  const sources = (await citation.handler({ brand_id: brand.id })).structuredContent.top_sources;
  assert.deepEqual(sources.map((source) => source.sample_url), ['https://news.example/safe-report']);
});

test('get_citations redacts repeated and encoded query credentials at all client-facing evidence boundaries', async () => {
  const citation = registerCitationTool(citationRow({
    raw_response: 'Acme is at https://acme.com/report?token=ANSWER_SECRET&ref=answer',
    engine_citations_json: JSON.stringify([
      'https://acme.com/report?API%5FKEY=NATIVE_SECRET&ref=provider&access_token=TOKEN_ONE&access_token=TOKEN_TWO',
    ]),
  }), [promptResponse({ engine_citations: [
    'https://research.example/article?client_secret=SOURCE_SECRET&page=2&KEY=ANOTHER_SECRET',
  ] })]);
  const result = (await citation.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.citations[0].cited_url,
    'https://acme.com/report?API%5FKEY=[REDACTED]&ref=provider&access_token=[REDACTED]&access_token=[REDACTED]');
  assert.equal(result.citations[0].url_source, 'provider_source');
  assert.equal(result.top_sources[0].sample_url,
    'https://research.example/article?client_secret=[REDACTED]&page=2&KEY=[REDACTED]');
  assert.match(result.citations[0].response_excerpt, /token=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), /NATIVE_SECRET|TOKEN_ONE|TOKEN_TWO|SOURCE_SECRET|ANOTHER_SECRET|ANSWER_SECRET/);
});

test('get_citations redacts credentials in stored buyer questions without hiding public context', async () => {
  const citation = registerCitationTool(citationRow({
    prompt: 'Compare Acme at https://research.example/guide?api_key=BUYER_API_SECRET&ref=client with Authorization: Bearer BUYER_BEARER_SECRET',
  }));
  const result = (await citation.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.citations[0].prompt,
    'Compare Acme at https://research.example/guide?api_key=[REDACTED]&ref=client with Authorization: Bearer [REDACTED]');
  assert.doesNotMatch(JSON.stringify(result.citations), /BUYER_API_SECRET|BUYER_BEARER_SECRET/);
});

test('get_citations redacts URL fragment credentials without changing public query and anchor context', async () => {
  const citation = registerCitationTool(citationRow({
    raw_response: 'Acme is at https://acme.com/report#access_token=EXCERPT_SECRET&section=summary',
    engine_citations_json: JSON.stringify([
      'https://acme.com/report?ref=native#id_token=NATIVE_ID&view=detail',
    ]),
  }), [promptResponse({ engine_citations: [
    'https://research.example/article#state=public&access_token=SOURCE_HASH',
  ] })]);
  const result = (await citation.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.citations[0].cited_url,
    'https://acme.com/report?ref=native#id_token=[REDACTED]&view=detail');
  assert.equal(result.top_sources[0].sample_url,
    'https://research.example/article#state=public&access_token=[REDACTED]');
  assert.match(result.citations[0].response_excerpt, /#access_token=\[REDACTED\]&section=summary/);
  assert.doesNotMatch(JSON.stringify(result), /NATIVE_ID|SOURCE_HASH|EXCERPT_SECRET/);
});

test('get_citations masks fragment credentials before a hash-route question mark', async () => {
  const citation = registerCitationTool(citationRow({
    raw_response: 'Acme cites https://acme.com/report#access_token=EXCERPT_SECRET?view=public',
    engine_citations_json: JSON.stringify([
      'https://acme.com/report#id_token=NATIVE_SECRET?view=public',
    ]),
  }), [promptResponse({ engine_citations: [
    'https://research.example/article#access_token=SOURCE_SECRET?view=public',
  ] })]);
  const result = (await citation.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.citations[0].cited_url,
    'https://acme.com/report#id_token=[REDACTED]?view=public');
  assert.equal(result.top_sources[0].sample_url,
    'https://research.example/article#access_token=[REDACTED]?view=public');
  assert.match(result.citations[0].response_excerpt,
    /#access_token=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), /NATIVE_SECRET|SOURCE_SECRET|EXCERPT_SECRET/);
});

test('get_citations redacts cloud signed-URL capabilities from all client-facing evidence', async () => {
  const citation = registerCitationTool(citationRow({
    raw_response: 'Acme cites https://acme.com/report?X-Goog-Signature=GOOGLE_SENTINEL&X-Goog-Credential=GOOGLE_ID_SENTINEL&X-Goog-Date=20261119T000000Z',
    engine_citations_json: JSON.stringify([
      'https://acme.com/report?X-Amz-Credential=AWS_ID_SENTINEL&X-Amz-Signature=AWS_SIG_SENTINEL&X-Amz-Security-Token=AWS_SESSION_SENTINEL&X-Amz-Expires=300',
    ]),
  }), [promptResponse({ engine_citations: [
    'https://research.example/article?sig=AZURE_SIG_SENTINEL&sp=r&sv=2022-11-02',
  ] })]);
  const result = (await citation.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.citations[0].cited_url,
    'https://acme.com/report?X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Security-Token=[REDACTED]&X-Amz-Expires=300');
  assert.equal(result.top_sources[0].sample_url,
    'https://research.example/article?sig=[REDACTED]&sp=r&sv=2022-11-02');
  assert.match(result.citations[0].response_excerpt, /X-Goog-Signature=\[REDACTED\]&X-Goog-Credential=\[REDACTED\]&X-Goog-Date=20261119T000000Z/);
  assert.doesNotMatch(JSON.stringify(result), /GOOGLE_SENTINEL|GOOGLE_ID_SENTINEL|AWS_ID_SENTINEL|AWS_SIG_SENTINEL|AWS_SESSION_SENTINEL|AZURE_SIG_SENTINEL/);
});

test('get_citations discloses masked citation links separately from unchanged URLs', async () => {
  const signed = 'https://acme.com/report?X-Amz-Signature=PRIVATE&X-Amz-Expires=300';
  const publicUrl = 'https://acme.com/guide?ref=public';
  const tool = registerCitationTool([
    citationRow({ response_id: 'signed', run_id: 'signed-run', prompt_id: 'p1',
      raw_response: 'Acme signed source', engine_citations_json: JSON.stringify([signed]) }),
    citationRow({ response_id: 'public', run_id: 'public-run', prompt_id: 'p2',
      raw_response: 'Acme public source', engine_citations_json: JSON.stringify([publicUrl]) }),
    citationRow({ response_id: 'none', run_id: 'none-run', prompt_id: 'p3',
      raw_response: 'Acme without linked source', engine_citations_json: '[]' }),
  ], [
    promptResponse({ id: 'provider-signed', run_id: 'signed-run', prompt_id: 'p1',
      engine_citations: ['https://signed.example/document?sig=PRIVATE'] }),
    promptResponse({ id: 'provider-public', run_id: 'public-run', prompt_id: 'p2',
      engine_citations: ['https://public.example/document?ref=public'] }),
  ]);
  const result = (await tool.handler({ brand_id: brand.id })).structuredContent;
  const rows = new Map(result.citations.map((row) => [row.id, row]));
  assert.equal(rows.get('cit_signed')?.url_redacted, true);
  assert.equal(rows.get('cit_public')?.url_redacted, false);
  assert.equal(rows.get('cit_none')?.url_redacted, false);
  const sources = new Map(result.top_sources.map((source) => [source.domain, source]));
  assert.equal(sources.get('signed.example')?.url_redacted, true);
  assert.equal(sources.get('public.example')?.url_redacted, false);
  assert.equal(sources.get('signed.example')?.sample_url.includes('PRIVATE'), false);
  assert.equal(sources.get('public.example')?.sample_url,
    'https://public.example/document?ref=public');
});

test('top source rankings exclude localhost, IP addresses and malformed DNS hosts', async () => {
  const citation = registerCitationTool(citationRow(), [
    promptResponse({ engine_citations: [
      'http://localhost/private',
      'https://127.0.0.1/admin',
      'https://[::1]/internal',
      'https://news..example/bad',
      'https://research.example/report',
    ] }),
  ]);
  const sources = (await citation.handler({ brand_id: brand.id })).structuredContent.top_sources;
  assert.deepEqual(sources.map((source) => source.domain), ['research.example']);
  assert.deepEqual(sources.map((source) => source.sample_url), ['https://research.example/report']);
});

test('top source rankings exclude internal and invalid hosts from historical provider evidence', async () => {
  const citation = registerCitationTool(citationRow(), [
    promptResponse({ engine_citations: [
      'https://wiki.office.local/internal',
      'https://gateway.staging.internal/dashboard',
      'https://service.localhost/private',
      'https://fixture.test/document',
      'https://invalid.invalid/document',
      'https://home.arpa/router',
      'https://router.home.arpa/status',
      'https://news.example.org/public',
    ] }),
  ]);
  const sources = (await citation.handler({ brand_id: brand.id })).structuredContent;
  assert.deepEqual(sources.top_sources.map((source) => source.domain), ['news.example.org']);
  assert.equal(sources.total_source_domains, 1);
  assert.deepEqual(sources.top_sources.map((source) => source.sample_url),
    ['https://news.example.org/public']);
});

test('get_citations distinguishes provider-listed link-only evidence from textual brand mentions', async () => {
  const citation = registerCitationTool(
    citationRow({
      raw_response: 'An unrelated vendor is recommended.',
      brand_mentioned: 0,
      brand_cited_with_link: 1,
      engine_citations_json: JSON.stringify(['https://acme.com/research']),
    }),
  );
  const result = await citation.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.citations[0].citation_type, 'source_link_only');
  assert.equal(result.structuredContent.citations[0].cited_url, 'https://acme.com/research');
  assert.equal(result.structuredContent.citations[0].url_source, 'provider_source');
});

test('get_citations does not attach unrelated or lookalike URLs to mention-only evidence', async () => {
  const citation = registerCitationTool(
    citationRow({
      raw_response: 'Acme is named, but https://notacme.com/ is another site.',
      brand_cited_with_link: 0,
      cited_urls_json: JSON.stringify([]),
      engine_citations_json: JSON.stringify(['https://acme.com.evil.example/article']),
    }),
  );
  const result = await citation.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.citations[0].citation_type, 'mention_without_link');
  assert.equal(result.structuredContent.citations[0].cited_url, null);
  assert.equal(result.structuredContent.citations[0].url_source, null);
});

test('get_citations discloses truncated source rankings and supports a bounded wider audit view', async () => {
  const domains = Array.from({ length: 13 }, (_, index) =>
    `https://source-${String(index + 1).padStart(2, '0')}.example/report`);
  const tool = registerCitationTool(citationRow(), [promptResponse({ engine_citations: domains })]);
  const defaultView = (await tool.handler({ brand_id: brand.id, limit: 1 })).structuredContent;
  assert.equal(defaultView.top_sources_limit, 10);
  assert.equal(defaultView.total_source_domains, 13);
  assert.equal(defaultView.top_sources_truncated, true);
  assert.equal(defaultView.top_sources.length, 10);
  const extended = (await tool.handler({ brand_id: brand.id, limit: 1, top_sources_limit: 20 })).structuredContent;
  assert.equal(extended.top_sources_limit, 20);
  assert.equal(extended.total_source_domains, 13);
  assert.equal(extended.top_sources_truncated, false);
  assert.equal(extended.top_sources.length, 13);
  assert.equal(extended.top_sources[12].domain, 'source-13.example');
  assert.equal(extended.total_matching_rows, defaultView.total_matching_rows);
  assert.deepEqual(extended.citations, defaultView.citations);
});

test('get_citations ranks engine-native source domains across the requested window', async () => {
  const observedAt = new Date(Date.UTC(2026, 8, 20)).toISOString();
  const citation = registerCitationTool(citationRow(), [
    promptResponse({
      id: 'response-1',
      prompt_id: 'prompt-1',
      engine: 'chatgpt',
      engine_citations: [
        'https://www.g2.com/categories/project-management',
        'https://g2.com/categories/project-management?ref=duplicate',
        'https://acme.com/guides/project-management',
        'not-a-url',
      ],
    }),
    promptResponse({
      id: 'response-2',
      run_id: 'run-2',
      prompt_id: 'prompt-2',
      engine: 'perplexity',
      engine_citations: ['https://g2.com/reports/project-management'],
    }),
    promptResponse({
      id: 'response-3',
      run_id: 'run-3',
      prompt_id: 'prompt-3',
      engine: 'gemini',
      engine_citations: ['https://example.org/pm-tools'],
    }),
  ]);

  const result = await citation.handler({ brand_id: brand.id });

  assert.deepEqual(result.structuredContent.top_sources, [
    {
      domain: 'g2.com',
      citation_count: 2,
      per_engine_citation_count: { chatgpt: 1, perplexity: 1 },
      per_engine_source_observation_percent: { chatgpt: 100, perplexity: 100 },
      per_engine_distinct_prompt_count: { chatgpt: 1, perplexity: 1 },
      per_engine_last_observed_at: { chatgpt: observedAt, perplexity: observedAt },
      per_engine_examples: {
        chatgpt: { sample_url: 'https://www.g2.com/categories/project-management', url_redacted: false,
          run_id: 'run-1', response_id: 'response-1' },
        perplexity: { sample_url: 'https://g2.com/reports/project-management', url_redacted: false,
          run_id: 'run-2', response_id: 'response-2' },
      },
      distinct_cited_path_count: 2,
      top_cited_paths: [
        { path: '/categories/project-management', response_count: 1 },
        { path: '/reports/project-management', response_count: 1 },
      ],
      prompt_count: 2,
      last_observed_at: observedAt,
      engines: ['chatgpt', 'perplexity'],
      measurement_modes: ['search_requested'],
      sample_url: 'https://www.g2.com/categories/project-management',
      url_redacted: false,
      is_brand_domain: false,
    },
    {
      domain: 'acme.com',
      citation_count: 1,
      per_engine_citation_count: { chatgpt: 1 },
      per_engine_source_observation_percent: { chatgpt: 100 },
      per_engine_distinct_prompt_count: { chatgpt: 1 },
      per_engine_last_observed_at: { chatgpt: observedAt },
      per_engine_examples: {
        chatgpt: { sample_url: 'https://acme.com/guides/project-management', url_redacted: false,
          run_id: 'run-1', response_id: 'response-1' },
      },
      distinct_cited_path_count: 1,
      top_cited_paths: [{ path: '/guides/project-management', response_count: 1 }],
      prompt_count: 1,
      last_observed_at: observedAt,
      engines: ['chatgpt'],
      measurement_modes: ['search_requested'],
      sample_url: 'https://acme.com/guides/project-management',
      url_redacted: false,
      is_brand_domain: true,
    },
    {
      domain: 'example.org',
      citation_count: 1,
      per_engine_citation_count: { gemini: 1 },
      per_engine_source_observation_percent: { gemini: 100 },
      per_engine_distinct_prompt_count: { gemini: 1 },
      per_engine_last_observed_at: { gemini: observedAt },
      per_engine_examples: {
        gemini: { sample_url: 'https://example.org/pm-tools', url_redacted: false,
          run_id: 'run-3', response_id: 'response-3' },
      },
      distinct_cited_path_count: 1,
      top_cited_paths: [{ path: '/pm-tools', response_count: 1 }],
      prompt_count: 1,
      last_observed_at: observedAt,
      engines: ['gemini'],
      measurement_modes: ['model_only'],
      sample_url: 'https://example.org/pm-tools',
      url_redacted: false,
      is_brand_domain: false,
    },
  ]);
});

test('top source summaries distinguish mixed model-only and search-requested observations', async () => {
  const captured_at = Date.now() - 60_000;
  const source = 'https://research.example/guide';
  const citation = registerCitationTool(citationRow({ captured_at }), [
    { ...promptResponse({ id: 'batch', run_id: 'batch', captured_at, engine: 'chatgpt', engine_citations: [source] }), mode: 'batch' },
    { ...promptResponse({ id: 'live', run_id: 'live', captured_at, engine: 'chatgpt', engine_citations: [source] }), mode: 'live' },
    { ...promptResponse({ id: 'claude', run_id: 'claude', captured_at, engine: 'claude', engine_citations: [source] }), mode: 'live' },
  ]);
  const result = await citation.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.top_sources[0].citation_count, 3);
  assert.deepEqual(result.structuredContent.top_sources[0].measurement_modes, ['model_only', 'search_requested']);
});

test('top sources count each engine once per response-domain and honor engine and mode selection', async () => {
  const citation = registerCitationTool(citationRow(), [
    promptResponse({ id: 'chat-a', run_id: 'chat-a', prompt_id: 'a', engine: 'chatgpt',
      engine_citations: ['https://research.example/one', 'https://www.research.example/two'] }),
    promptResponse({ id: 'chat-b', run_id: 'chat-b', prompt_id: 'b', engine: 'chatgpt',
      engine_citations: ['https://research.example/one'] }),
    promptResponse({ id: 'perplexity', run_id: 'perplexity', prompt_id: 'c', engine: 'perplexity',
      engine_citations: ['https://research.example/three', 'https://research.example/three?ref=repeat'] }),
    promptResponse({ id: 'claude', run_id: 'claude', prompt_id: 'd', engine: 'claude',
      engine_citations: ['https://research.example/four'] }),
  ]);

  const all = (await citation.handler({ brand_id: brand.id })).structuredContent.top_sources[0];
  assert.equal(all.citation_count, 4);
  assert.deepEqual(all.per_engine_citation_count, { chatgpt: 2, claude: 1, perplexity: 1 });
  assert.equal(Object.values(all.per_engine_citation_count).reduce((sum, count) => sum + count, 0), all.citation_count);

  const selected = (await citation.handler({ brand_id: brand.id, engines: ['perplexity', 'chatgpt'] }))
    .structuredContent.top_sources[0];
  assert.equal(selected.citation_count, 3);
  assert.deepEqual(selected.per_engine_citation_count, { chatgpt: 2, perplexity: 1 });

  const model = (await citation.handler({ brand_id: brand.id, measurement_mode: 'model_only' }))
    .structuredContent.top_sources[0];
  assert.equal(model.citation_count, 1);
  assert.deepEqual(model.per_engine_citation_count, { claude: 1 });
});

test('source prompt breadth per engine does not count repeated observations as new prompts', async () => {
  const url = 'https://research.example/guide';
  const citation = registerCitationTool(citationRow(), [
    promptResponse({ id: 'chat-1', run_id: 'chat-run-1', prompt_id: 'shared',
      engine: 'chatgpt', engine_citations: [url, url] }),
    promptResponse({ id: 'chat-2', run_id: 'chat-run-2', prompt_id: 'shared',
      engine: 'chatgpt', engine_citations: [url] }),
    promptResponse({ id: 'chat-3', run_id: 'chat-run-3', prompt_id: 'unique',
      engine: 'chatgpt', engine_citations: [url] }),
    promptResponse({ id: 'claude-1', run_id: 'claude-run', prompt_id: 'shared',
      engine: 'claude', engine_citations: [url] }),
    promptResponse({ id: 'perplexity-1', run_id: 'perplexity-run', prompt_id: 'third',
      engine: 'perplexity', engine_citations: [url] }),
  ]);

  const all = (await citation.handler({ brand_id: brand.id })).structuredContent.top_sources[0];
  assert.equal(all.citation_count, 5);
  assert.deepEqual(all.per_engine_citation_count, { chatgpt: 3, claude: 1, perplexity: 1 });
  assert.deepEqual(all.per_engine_distinct_prompt_count, { chatgpt: 2, claude: 1, perplexity: 1 });
  assert.equal(all.prompt_count, 3, 'global prompt IDs are not the sum of per-engine breadth');

  const scoped = (await citation.handler({ brand_id: brand.id, engines: ['chatgpt', 'claude'] }))
    .structuredContent.top_sources[0];
  assert.deepEqual(scoped.per_engine_distinct_prompt_count, { chatgpt: 2, claude: 1 });
  assert.equal(scoped.prompt_count, 2);

  const modelOnly = (await citation.handler({ brand_id: brand.id, measurement_mode: 'model_only' }))
    .structuredContent.top_sources[0];
  assert.deepEqual(modelOnly.per_engine_distinct_prompt_count, { claude: 1 });
});

test('source freshness is scoped by engine and measurement mode rather than inherited from the newest engine', async () => {
  const recent = Date.now() - 60_000;
  const older = recent - 2 * 86_400_000;
  const middle = recent - 86_400_000;
  const source = 'https://research.example/guide';
  const citation = registerCitationTool(citationRow({ captured_at: recent }), [
    { ...promptResponse({ id: 'chat-batch', run_id: 'chat-batch', prompt_id: 'a',
      captured_at: older, engine: 'chatgpt', engine_citations: [source] }), mode: 'batch' },
    promptResponse({ id: 'perplexity', run_id: 'perplexity', prompt_id: 'b',
      captured_at: middle, engine: 'perplexity', engine_citations: [source] }),
    promptResponse({ id: 'chat-live', run_id: 'chat-live', prompt_id: 'c',
      captured_at: recent, engine: 'chatgpt', engine_citations: [source] }),
  ]);

  const all = (await citation.handler({ brand_id: brand.id })).structuredContent.top_sources[0];
  assert.equal(all.last_observed_at, new Date(recent).toISOString());
  assert.deepEqual(all.per_engine_last_observed_at, {
    chatgpt: new Date(recent).toISOString(),
    perplexity: new Date(middle).toISOString(),
  });

  const model = (await citation.handler({ brand_id: brand.id, measurement_mode: 'model_only' }))
    .structuredContent.top_sources[0];
  assert.deepEqual(model.per_engine_last_observed_at, { chatgpt: new Date(older).toISOString() });
  assert.equal(model.last_observed_at, new Date(older).toISOString());

  const selected = (await citation.handler({ brand_id: brand.id, engines: ['perplexity'] }))
    .structuredContent.top_sources[0];
  assert.deepEqual(selected.per_engine_last_observed_at, { perplexity: new Date(middle).toISOString() });
  assert.equal(selected.last_observed_at, new Date(middle).toISOString());
});

test('top source examples keep separate latest cited URLs by engine, with stable ties and credential masking', async () => {
  const latest = Date.now() - 60_000;
  const older = latest - 2 * 86_400_000;
  const middle = latest - 86_400_000;
  const citation = registerCitationTool(citationRow({ captured_at: latest }), [
    { ...promptResponse({ id: 'chat-older', run_id: 'chat-older', prompt_id: 'a', engine: 'chatgpt',
      captured_at: older, engine_citations: ['https://research.example/old-chat'] }), mode: 'batch' },
    promptResponse({ id: 'perplexity', run_id: 'perplexity', prompt_id: 'b', engine: 'perplexity',
      captured_at: middle, engine_citations: ['https://research.example/perplexity?ref=public'] }),
    promptResponse({ id: 'chat-z', run_id: 'chat-z', prompt_id: 'c', engine: 'chatgpt',
      captured_at: latest, engine_citations: ['https://research.example/chat-z?token=secret-z'] }),
    promptResponse({ id: 'chat-a', run_id: 'chat-a', prompt_id: 'd', engine: 'chatgpt',
      captured_at: latest, engine_citations: ['https://research.example/chat-a?access_token=secret-a&ref=public'] }),
  ]);

  const all = (await citation.handler({ brand_id: brand.id })).structuredContent.top_sources[0];
  assert.deepEqual(all.per_engine_examples, {
    chatgpt: { sample_url: 'https://research.example/chat-a?access_token=[REDACTED]&ref=public', url_redacted: true,
      run_id: 'chat-a', response_id: 'chat-a' },
    perplexity: { sample_url: 'https://research.example/perplexity?ref=public', url_redacted: false,
      run_id: 'perplexity', response_id: 'perplexity' },
  });
  assert.equal(all.sample_url, all.per_engine_examples.chatgpt.sample_url);

  const modelOnly = (await citation.handler({ brand_id: brand.id, measurement_mode: 'model_only' }))
    .structuredContent.top_sources[0];
  assert.deepEqual(modelOnly.per_engine_examples, {
    chatgpt: { sample_url: 'https://research.example/old-chat', url_redacted: false,
      run_id: 'chat-older', response_id: 'chat-older' },
  });

  const selected = (await citation.handler({ brand_id: brand.id, engines: ['perplexity'] }))
    .structuredContent.top_sources[0];
  assert.deepEqual(selected.per_engine_examples, {
    perplexity: { sample_url: 'https://research.example/perplexity?ref=public', url_redacted: false,
      run_id: 'perplexity', response_id: 'perplexity' },
  });
});

test('source observation percentages use full-window per-engine successful response denominators', async () => {
  const recent = Date.now() - 60_000;
  const cited = 'https://research.example/guide';
  const citation = registerCitationTool(citationRow({ captured_at: recent }), [
    promptResponse({ id: 'chat-1', run_id: 'chat-1', prompt_id: 'a', engine: 'chatgpt',
      captured_at: recent, engine_citations: [cited, cited] }),
    promptResponse({ id: 'chat-2', run_id: 'chat-2', prompt_id: 'b', engine: 'chatgpt',
      captured_at: recent, engine_citations: [] }),
    promptResponse({ id: 'chat-3', run_id: 'chat-3', prompt_id: 'a', engine: 'chatgpt',
      captured_at: recent, engine_citations: [cited] }),
    { ...promptResponse({ id: 'chat-batch', run_id: 'chat-batch', prompt_id: 'c', engine: 'chatgpt',
      captured_at: recent, engine_citations: [cited] }), mode: 'batch' },
    promptResponse({ id: 'perp-1', run_id: 'perp-1', prompt_id: 'a', engine: 'perplexity',
      captured_at: recent, engine_citations: [cited] }),
    promptResponse({ id: 'perp-2', run_id: 'perp-2', prompt_id: 'b', engine: 'perplexity',
      captured_at: recent, engine_citations: ['https://other.example/'] }),
    promptResponse({ id: 'gemini-1', run_id: 'gemini-1', prompt_id: 'c', engine: 'gemini',
      captured_at: recent, engine_citations: [] }),
  ]);

  const all = (await citation.handler({ brand_id: brand.id, limit: 1 })).structuredContent;
  const research = all.top_sources.find((source) => source.domain === 'research.example');
  assert.ok(research);
  assert.deepEqual(research.per_engine_source_observation_percent, { chatgpt: 75, perplexity: 50 });
  assert.equal(all.observation_coverage.per_engine.find((entry) => entry.engine === 'chatgpt')?.successful_observation_count, 4);
  assert.equal(research.citation_count, 4);

  const searchOnly = (await citation.handler({ brand_id: brand.id, measurement_mode: 'search_requested' }))
    .structuredContent.top_sources.find((source) => source.domain === 'research.example');
  assert.deepEqual(searchOnly?.per_engine_source_observation_percent, { chatgpt: 66.7, perplexity: 50 });
  const modelOnly = (await citation.handler({ brand_id: brand.id, measurement_mode: 'model_only' }))
    .structuredContent.top_sources.find((source) => source.domain === 'research.example');
  assert.deepEqual(modelOnly?.per_engine_source_observation_percent, { chatgpt: 100 });
  const selected = (await citation.handler({ brand_id: brand.id, engines: ['perplexity'] }))
    .structuredContent.top_sources.find((source) => source.domain === 'research.example');
  assert.deepEqual(selected?.per_engine_source_observation_percent, { perplexity: 50 });
});

test('source path breadth counts distinct cited paths without inflating response-domain observations', async () => {
  const citation = registerCitationTool(citationRow(), [
    promptResponse({
      id: 'path-one', prompt_id: 'prompt-1',
      engine_citations: [
        'https://research.example/guide?utm_source=one',
        'https://research.example/guide#section',
        'https://research.example/report?token=fixture',
        'https://research.example/analysis',
      ],
    }),
    promptResponse({
      id: 'path-two', run_id: 'run-two', prompt_id: 'prompt-2',
      engine_citations: ['https://www.research.example/guide?utm_source=two'],
    }),
  ]);

  const result = (await citation.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.top_sources[0].domain, 'research.example');
  assert.equal(result.top_sources[0].citation_count, 2);
  assert.equal(result.top_sources[0].distinct_cited_path_count, 3);
  assert.deepEqual(result.top_sources[0].top_cited_paths, [
    { path: '/guide', response_count: 2 },
    { path: '/analysis', response_count: 1 },
    { path: '/report', response_count: 1 },
  ]);
  assert.equal(result.top_sources[0].prompt_count, 2);
});

test('get_citations masks access-bearing URL path segments without losing distinct source-path breadth', async () => {
  const citation = registerCitationTool(citationRow({
    raw_response: 'Acme cites https://acme.com/password-reset/EXCERPT_PATH?ref=public',
    engine_citations_json: JSON.stringify(['https://acme.com/api-key/NATIVE_PATH?ref=public']),
  }), [promptResponse({ engine_citations: [
    'https://research.example/password-reset/SOURCE_PATH_ONE?ref=public',
    'https://research.example/password-reset/SOURCE_PATH_TWO?ref=public',
    'https://research.example/guide',
  ] })]);
  const result = (await citation.handler({ brand_id: brand.id })).structuredContent;
  assert.equal(result.citations[0].cited_url, 'https://acme.com/api-key/[REDACTED]?ref=public');
  assert.match(result.citations[0].response_excerpt, /password-reset\/\[REDACTED\]\?ref=public/);
  assert.equal(result.top_sources[0].sample_url,
    'https://research.example/password-reset/[REDACTED]?ref=public');
  assert.equal(result.top_sources[0].distinct_cited_path_count, 3);
  assert.deepEqual(result.top_sources[0].top_cited_paths, [
    { path: '/guide', response_count: 1 },
    { path: '/password-reset/[REDACTED]', response_count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(result),
    /EXCERPT_PATH|NATIVE_PATH|SOURCE_PATH_ONE|SOURCE_PATH_TWO/);
});

test('top cited source paths are bounded and tie-broken deterministically', async () => {
  const tool = registerCitationTool(citationRow(), [
    promptResponse({
      engine_citations: ['z', 'a', 'e', 'c', 'b', 'd'].map((path) => `https://research.example/${path}`),
    }),
  ]);
  const source = (await tool.handler({ brand_id: brand.id })).structuredContent.top_sources[0];
  assert.equal(source.distinct_cited_path_count, 6);
  assert.deepEqual(source.top_cited_paths, ['a', 'b', 'c', 'd', 'e'].map((path) => ({
    path: `/${path}`, response_count: 1,
  })));
});

test('get_citations aggregates sources without fetching full AI response bodies', async () => {
  const citation = registerCitationTool(citationRow({ captured_at: Date.now() - 1000 }), [
    promptResponse({
      captured_at: Date.now() - 1000,
      engine_citations: ['https://research.example/source'],
      raw_response: 'Sensitive full AI answer not needed to aggregate sources',
    }),
  ]);
  const result = await citation.handler({ brand_id: brand.id });
  assert.equal(result.structuredContent.top_sources[0].domain, 'research.example');
  assert.equal(result.structuredContent.top_sources[0].citation_count, 1);
});

test('top source evidence spans the complete window on every cursor page', async () => {
  const observed = Date.now() - 1000;
  const citation = registerCitationTool([
    citationRow({ prompt_id: 'p1', captured_at: observed }),
    citationRow({ prompt_id: 'p2', captured_at: observed - 100 }),
  ], [
    promptResponse({
      id: 'first-source',
      prompt_id: 'p1',
      captured_at: observed,
      engine_citations: ['https://research.example/first'],
    }),
    promptResponse({
      id: 'second-source',
      prompt_id: 'p2',
      captured_at: observed - 100,
      engine_citations: ['https://research.example/second'],
    }),
  ]);
  const first = await citation.handler({ brand_id: brand.id, limit: 1 });
  assert.ok(first.structuredContent.next_cursor);
  const second = await citation.handler({
    brand_id: brand.id, limit: 1, cursor: first.structuredContent.next_cursor!,
  });
  assert.equal(first.structuredContent.citations.length, 1);
  assert.equal(second.structuredContent.citations.length, 1);
  assert.deepEqual(first.structuredContent.top_sources, second.structuredContent.top_sources);
  assert.equal(first.structuredContent.top_sources[0].citation_count, 2);
  assert.equal(first.structuredContent.top_sources[0].prompt_count, 2);
  assert.equal(first.structuredContent.top_sources[0].last_observed_at, new Date(observed).toISOString());
});

test('top source sample links use the latest observation regardless of database row order', async () => {
  const older = promptResponse({
    id: 'older-source',
    captured_at: Date.now() - 120_000,
    engine_citations: ['https://research.example/old-report'],
  });
  const newer = promptResponse({
    id: 'newer-source',
    captured_at: Date.now() - 60_000,
    engine_citations: ['https://research.example/new-report'],
  });
  for (const responses of [[older, newer], [newer, older]]) {
    const tool = registerCitationTool(citationRow({ captured_at: Date.now() - 60_000 }), responses);
    const result = await tool.handler({ brand_id: brand.id });
    assert.equal(result.structuredContent.top_sources[0].citation_count, 2);
    assert.equal(result.structuredContent.top_sources[0].sample_url, 'https://research.example/new-report');
    assert.equal(result.structuredContent.top_sources[0].last_observed_at, new Date(newer.captured_at).toISOString());
  }
});

test('get_citations source ranking honors the engine filter', async () => {
  const citation = registerCitationTool(citationRow(), [
    promptResponse({
      engine: 'chatgpt',
      engine_citations: ['https://g2.com/chatgpt-source'],
    }),
    promptResponse({
      id: 'response-2',
      run_id: 'run-2',
      prompt_id: 'prompt-2',
      engine: 'perplexity',
      engine_citations: ['https://reddit.com/r/projectmanagement'],
    }),
  ]);

  const result = await citation.handler({
    brand_id: brand.id,
    engine: 'perplexity',
  });

  assert.deepEqual(
    result.structuredContent.top_sources.map((source) => source.domain),
    ['reddit.com'],
  );
});

test('get_citations selected engines filter before pagination and source rankings and bind the cursor scope', async () => {
  const at = Date.now() - 60_000;
  const tool = registerCitationTool([
    citationRow({ response_id: 'chat-1', run_id: 'r-chat', prompt_id: 'p-chat', engine: 'chatgpt', captured_at: at + 2 }),
    citationRow({ response_id: 'claude-1', run_id: 'r-claude', prompt_id: 'p-claude', engine: 'claude', captured_at: at + 1 }),
    citationRow({ response_id: 'perp-1', run_id: 'r-perp', prompt_id: 'p-perp', engine: 'perplexity', captured_at: at }),
  ], [
    promptResponse({ id: 'chat-source', run_id: 'r-chat', engine: 'chatgpt',
      engine_citations: ['https://chat.example/a'], captured_at: at + 2 }),
    // Newest response first: freshness must not depend on source-row iteration order.
    promptResponse({ id: 'claude-repeat', run_id: 'r-claude-repeat', prompt_id: 'prompt-1',
      engine: 'claude', engine_citations: [], captured_at: at + 3 }),
    promptResponse({ id: 'claude-source', run_id: 'r-claude', engine: 'claude',
      engine_citations: ['https://claude.example/a'], captured_at: at + 1 }),
    promptResponse({ id: 'claude-unmentioned', run_id: 'r-claude-unmentioned', prompt_id: 'p-other',
      engine: 'claude', engine_citations: [], captured_at: at + 1 }),
    promptResponse({ id: 'perp-source', run_id: 'r-perp', engine: 'perplexity',
      engine_citations: ['https://perplexity.example/a'], captured_at: at }),
  ]);
  const engines = ['perplexity', 'claude'] as const;
  const first = (await tool.handler({ brand_id: brand.id, engines: [...engines], limit: 1 })).structuredContent;
  assert.equal(first.has_more, true);
  assert.equal(first.citations.length, 1);
  assert.deepEqual(first.top_sources.map(({ domain }) => domain).sort(),
    ['claude.example', 'perplexity.example']);
  assert.deepEqual(first.engine_scope.requested_engines, ['claude', 'perplexity']);
  assert.deepEqual(first.engine_scope.not_observed_engines, []);
  assert.deepEqual(first.observation_coverage.per_engine, [
    { engine: 'claude', successful_observation_count: 3, distinct_prompt_count: 2,
      last_observed_at: new Date(at + 3).toISOString() },
    { engine: 'perplexity', successful_observation_count: 1, distinct_prompt_count: 1,
      last_observed_at: new Date(at).toISOString() },
  ]);
  assert.match(first.observation_coverage.note, /not.*citation|not.*visibility/i);
  assert.match(first.observation_coverage.note, /distinct.*prompt|last.*observed/i);
  const withMissing = (await tool.handler({
    brand_id: brand.id, engines: ['ai_mode', 'claude'],
  })).structuredContent;
  assert.deepEqual(withMissing.engine_scope.not_observed_engines, ['ai_mode']);
  assert.deepEqual(withMissing.observation_coverage.per_engine, [
    { engine: 'ai_mode', successful_observation_count: 0, distinct_prompt_count: 0,
      last_observed_at: null },
    { engine: 'claude', successful_observation_count: 3, distinct_prompt_count: 2,
      last_observed_at: new Date(at + 3).toISOString() },
  ]);
  const second = (await tool.handler({
    brand_id: brand.id, engines: ['claude', 'perplexity'], limit: 1, cursor: first.next_cursor!,
  })).structuredContent;
  assert.equal(second.citations.length, 1);
  assert.equal(second.has_more, false);
  assert.deepEqual(second.observation_coverage, first.observation_coverage);
  assert.notEqual(first.citations[0].id, second.citations[0].id);
  await assert.rejects(tool.handler({
    brand_id: brand.id, engines: ['claude'], cursor: first.next_cursor!,
  }), /Invalid citation cursor/);
  await assert.rejects(tool.handler({
    brand_id: brand.id, engine: 'claude', engines: ['perplexity'],
  }), /engine.*engines/i);
  const all = (await tool.handler({ brand_id: brand.id, engines: [] })).structuredContent;
  assert.equal(all.citations.length, 3);
  assert.equal(all.engine_scope.selection, 'all_stored');
  assert.deepEqual(all.observation_coverage.per_engine, [
    { engine: 'chatgpt', successful_observation_count: 1, distinct_prompt_count: 1,
      last_observed_at: new Date(at + 2).toISOString() },
    { engine: 'claude', successful_observation_count: 3, distinct_prompt_count: 2,
      last_observed_at: new Date(at + 3).toISOString() },
    { engine: 'perplexity', successful_observation_count: 1, distinct_prompt_count: 1,
      last_observed_at: new Date(at).toISOString() },
  ]);
});

test('get_citations provides stable cursor pages for tied observation timestamps', async () => {
  const observed = Date.now() - 60_000;
  const tool = registerCitationTool([
    citationRow({ prompt: 'first', prompt_id: 'p1', captured_at: observed }),
    citationRow({ prompt: 'second', prompt_id: 'p2', captured_at: observed }),
    citationRow({ prompt: 'third', prompt_id: 'p3', captured_at: observed }),
  ]);
  const first = await tool.handler({ brand_id: brand.id, limit: 2 });
  assert.equal(first.structuredContent.has_more, true);
  assert.ok(first.structuredContent.next_cursor);
  assert.equal(first.structuredContent.citations.length, 2);
  const second = await tool.handler({
    brand_id: brand.id,
    limit: 2,
    cursor: first.structuredContent.next_cursor!,
  });
  assert.equal(second.structuredContent.has_more, false);
  assert.equal(second.structuredContent.next_cursor, null);
  assert.equal(second.structuredContent.citations.length, 1);
  const ids = [...first.structuredContent.citations, ...second.structuredContent.citations]
    .map((row) => row.id);
  assert.equal(new Set(ids).size, 3);
});

test('get_citations paginates fractional-day windows without losing the cursor scope', async () => {
  const observed = Date.now() - 60_000;
  const tool = registerCitationTool([
    citationRow({ prompt_id: 'p1', captured_at: observed }),
    citationRow({ prompt_id: 'p2', captured_at: observed - 1000 }),
  ]);
  const days = 1.23456789;
  const first = await tool.handler({ brand_id: brand.id, days, limit: 1 });
  assert.equal(first.structuredContent.has_more, true);
  assert.ok(first.structuredContent.next_cursor);
  const second = await tool.handler({
    brand_id: brand.id, days, limit: 1, cursor: first.structuredContent.next_cursor!,
  });
  assert.equal(second.structuredContent.citations.length, 1);
  assert.equal(second.structuredContent.has_more, false);
  assert.equal(second.structuredContent.next_cursor, null);
  await assert.rejects(
    tool.handler({ brand_id: brand.id, days: 1.5, limit: 1, cursor: first.structuredContent.next_cursor! }),
    /Invalid citation cursor/,
  );
});

test('get_citations continues legacy historical v1 cursors without identity fields', async () => {
  const observed = Date.now() - 1000;
  const tool = registerCitationTool([
    citationRow({ prompt_id: 'p1', captured_at: observed }),
    citationRow({ prompt_id: 'p2', captured_at: observed - 1 }),
  ]);
  const first = (await tool.handler({ brand_id: brand.id, limit: 1 })).structuredContent;
  assert.ok(first.next_cursor);
  const legacy = JSON.parse(decodeURIComponent(first.next_cursor));
  delete legacy.identity_selection;
  delete legacy.identity_boundary;
  const second = (await tool.handler({
    brand_id: brand.id,
    cursor: encodeURIComponent(JSON.stringify(legacy)),
    limit: 1,
  })).structuredContent;
  assert.equal(second.citations.length, 1);
  assert.equal(second.has_more, false);
  assert.notEqual(first.citations[0].id, second.citations[0].id);
});

test('get_citations rejects a cursor used with a different brand or engine', async () => {
  const observed = Date.now() - 1_000;
  const tool = registerCitationTool([
    citationRow({ captured_at: observed, prompt_id: 'p1' }),
    citationRow({ captured_at: observed, prompt_id: 'p2' }),
  ]);
  const first = await tool.handler({ brand_id: brand.id, limit: 1 });
  assert.ok(first.structuredContent.next_cursor);
  await assert.rejects(
    tool.handler({ brand_id: 'another-brand', limit: 1, cursor: first.structuredContent.next_cursor! }),
    /Invalid citation cursor/,
  );
  await assert.rejects(
    tool.handler({ brand_id: brand.id, engine: 'claude', limit: 1, cursor: first.structuredContent.next_cursor! }),
    /Invalid citation cursor/,
  );
  await assert.rejects(
    tool.handler({ brand_id: brand.id, cursor: '%7B%22broken%22%3Atrue%7D' }),
    /Invalid citation cursor/,
  );
});

test('get_citations refuses forged or expired time windows in cursor pagination', async () => {
  const observed = Date.now() - 1_000;
  const tool = registerCitationTool([
    citationRow({ captured_at: observed, prompt_id: 'p1' }),
    citationRow({ captured_at: observed, prompt_id: 'p2' }),
  ]);
  const first = await tool.handler({ brand_id: brand.id, limit: 1 });
  assert.ok(first.structuredContent.next_cursor);
  const original = JSON.parse(decodeURIComponent(first.structuredContent.next_cursor!));
  const alterations = [
    { ...original, since: 0 },
    { ...original, until: Date.now() + 86_400_000, since: Date.now() + 86_400_000 - 14 * 86_400_000 },
    { ...original, until: Date.now() - 3 * 86_400_000, since: Date.now() - 17 * 86_400_000 },
    { ...original, before: { ...original.before, captured_at: original.since - 1 } },
  ];
  for (const forged of alterations) {
    await assert.rejects(
      tool.handler({ brand_id: brand.id, limit: 1, cursor: encodeURIComponent(JSON.stringify(forged)) }),
      /Invalid citation cursor/,
    );
  }
});
