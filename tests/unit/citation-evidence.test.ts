import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type { Brand, CitationRow, Db } from '../../src/db/types.ts';

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
  citations: Array<{ cited_url: string | null }>;
};

type CitationTool = {
  handler: (args: {
    brand_id: string;
    days?: number;
    engine?: 'chatgpt' | 'claude' | 'perplexity' | 'gemini' | 'ai_overviews';
  }) => Promise<{ structuredContent: CitationResult }>;
};

function registerCitationTool(row: CitationRow): CitationTool {
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
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  assert.ok(citationTool, 'get_citations tool registration missing');
  return citationTool;
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
