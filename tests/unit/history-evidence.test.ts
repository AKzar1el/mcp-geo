import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type { Db, VisibilityHistoryRow } from '../../src/db/types.ts';

type HistoryPoint = {
  date: string;
  overall_score: number;
  per_engine: Record<string, number>;
  per_engine_evidence: Record<
    string,
    { brand_mentions: number; usable_prompts: number; observed_at: string }
  >;
};

type HistoryTool = {
  handler: (args: {
    brand_id: string;
    days: number;
    granularity: 'daily' | 'weekly';
  }) => Promise<{ structuredContent: { series: HistoryPoint[] } }>;
};

function registerHistoryTool(rows: VisibilityHistoryRow[]): HistoryTool {
  let history: HistoryTool | undefined;
  const server = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === 'get_visibility_history') {
        history = { handler: handler as HistoryTool['handler'] };
      }
    },
  } as unknown as McpServer;

  registerTools(server, {
    db: {
      getVisibilityHistoryRows: async () => rows,
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  assert.ok(history, 'get_visibility_history tool registration missing');
  return history;
}

test('visibility history exposes the evidence denominator behind each engine score', async () => {
  const chatgptEarly = Date.UTC(2026, 0, 5, 10);
  const claude = Date.UTC(2026, 0, 5, 11);
  const chatgptLatest = Date.UTC(2026, 0, 5, 12);
  const history = registerHistoryTool([
    {
      run_id: 'chatgpt-early',
      engine: 'chatgpt',
      completed_at: chatgptEarly,
      total: 10,
      hits: 5,
    },
    {
      run_id: 'claude',
      engine: 'claude',
      completed_at: claude,
      total: 10,
      hits: 8,
    },
    {
      run_id: 'chatgpt-latest',
      engine: 'chatgpt',
      completed_at: chatgptLatest,
      total: 20,
      hits: 12,
    },
  ]);

  const result = await history.handler({
    brand_id: 'acme',
    days: 30,
    granularity: 'daily',
  });

  assert.deepEqual(result.structuredContent.series, [
    {
      date: '2026-01-05',
      overall_score: 70,
      per_engine: { chatgpt: 60, claude: 80 },
      per_engine_evidence: {
        chatgpt: {
          brand_mentions: 12,
          usable_prompts: 20,
          observed_at: new Date(chatgptLatest).toISOString(),
        },
        claude: {
          brand_mentions: 8,
          usable_prompts: 10,
          observed_at: new Date(claude).toISOString(),
        },
      },
    },
  ]);
});
