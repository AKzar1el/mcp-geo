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
  your_share_of_voice_pct: number;
  your_mentions: number;
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
  }) => Promise<{ structuredContent: ComparisonResult }>;
};

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
