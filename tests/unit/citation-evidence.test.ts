import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type {
  Brand,
  CitationRow,
  Db,
  PromptResponse,
} from '../../src/db/types.ts';

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
  top_sources: Array<{
    domain: string;
    citation_count: number;
    prompt_count: number;
    engines: string[];
    sample_url: string;
    is_brand_domain: boolean;
  }>;
  citations: Array<{ cited_url: string | null }>;
};

type CitationTool = {
  handler: (args: {
    brand_id: string;
    days?: number;
    engine?: 'chatgpt' | 'claude' | 'perplexity' | 'gemini' | 'ai_overviews';
  }) => Promise<{ structuredContent: CitationResult }>;
};

function registerCitationTool(
  row: CitationRow,
  responses: PromptResponse[] = [],
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
      getBrand: async () => brand,
      getCitationRows: async () => [row],
      getResponsesSince: async () => responses,
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  assert.ok(citationTool, 'get_citations tool registration missing');
  return citationTool;
}

function promptResponse(
  overrides: Partial<PromptResponse> = {},
): PromptResponse {
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
});

test('get_citations falls back to normalized host evidence when engine URLs are unrelated', async () => {
  const citation = registerCitationTool(
    citationRow({
      engine_citations_json: JSON.stringify([
        'https://example.org/reference',
        'not-a-url',
      ]),
    }),
  );

  const result = await citation.handler({ brand_id: brand.id });

  assert.equal(result.structuredContent.citations[0].cited_url, 'https://acme.com/');
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
      sample_url: 'https://www.g2.com/categories/project-management',
      is_brand_domain: false,
    },
    {
      domain: 'acme.com',
      citation_count: 1,
      prompt_count: 1,
      engines: ['chatgpt'],
      sample_url: 'https://acme.com/guides/project-management',
      is_brand_domain: true,
    },
    {
      domain: 'example.org',
      citation_count: 1,
      prompt_count: 1,
      engines: ['gemini'],
      sample_url: 'https://example.org/pm-tools',
      is_brand_domain: false,
    },
  ]);
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
