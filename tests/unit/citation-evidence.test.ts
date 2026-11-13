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
  google_search_sampling: null | {
    engines: string[];
    country: 'us';
    language: 'en';
    scope_note: string;
  };
  top_sources: Array<{
    domain: string;
    citation_count: number;
    prompt_count: number;
    engines: string[];
    measurement_modes: Array<'model_only' | 'search_requested'>;
    sample_url: string;
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
    cited_url: string | null;
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
    limit?: number;
    cursor?: string;
    current_identity_only?: boolean;
    active_prompts_only?: boolean;
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
      getCitationRows: async (_brandId, _since, engine, page) => {
        const rows = (Array.isArray(row) ? row : [row])
          .filter((item) => !engine || item.engine === engine)
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
      getCitationSourceRows: async (_brandId, _since, until, engine, minRunStartedAt, activeOnly) =>
        responses
          .filter((response) => response.captured_at <= until && (!engine || response.engine === engine))
          .filter((response) => minRunStartedAt === undefined ||
            (typeof response.run_started_at === 'number' && response.run_started_at >= minRunStartedAt))
          .filter((response) => !activeOnly || activeIds.includes(response.prompt_id))
          .map(({ id, prompt_id, engine: responseEngine, mode, captured_at, engine_citations, run_started_at }) => ({
            id,
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
  assert.equal(full.identity_filter.selection, 'full_history');
  assert.equal(full.top_sources.length, 3);

  const first = (await tool.handler({ brand_id: brand.id, current_identity_only: true, limit: 1 })).structuredContent;
  assert.equal(first.identity_filter.selection, 'current_identity_only');
  assert.equal(first.identity_filter.applied, true);
  assert.equal(first.citations.length, 1);
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
  assert.equal(historical.top_sources.length, 2);
  assert.equal(historical.prompt_set_scope.selection, 'full_history');

  const active = (await tool.handler({ brand_id: brand.id, active_prompts_only: true, limit: 1 })).structuredContent;
  assert.equal(active.citations.length, 1);
  assert.equal(active.citations[0].id, 'cit_current');
  assert.equal(active.has_more, false);
  assert.equal(active.prompt_set_scope.selection, 'active_only');
  assert.equal(active.prompt_set_scope.active_prompt_count, 1);
  assert.deepEqual(active.top_sources.map(({ domain }) => domain), ['new.example']);

  const noActive = registerCitationTool(rows, sources, brand, []);
  const empty = (await noActive.handler({ brand_id: brand.id, active_prompts_only: true })).structuredContent;
  assert.equal(empty.citations.length, 0);
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

test('get_citations ranks engine-native source domains across the requested window', async () => {
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
      prompt_count: 2,
      engines: ['chatgpt', 'perplexity'],
      measurement_modes: ['search_requested'],
      sample_url: 'https://www.g2.com/categories/project-management',
      is_brand_domain: false,
    },
    {
      domain: 'acme.com',
      citation_count: 1,
      prompt_count: 1,
      engines: ['chatgpt'],
      measurement_modes: ['search_requested'],
      sample_url: 'https://acme.com/guides/project-management',
      is_brand_domain: true,
    },
    {
      domain: 'example.org',
      citation_count: 1,
      prompt_count: 1,
      engines: ['gemini'],
      measurement_modes: ['model_only'],
      sample_url: 'https://example.org/pm-tools',
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
