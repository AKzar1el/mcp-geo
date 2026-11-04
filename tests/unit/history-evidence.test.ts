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
      overall_score: 69,
      per_engine: { chatgpt: 57, claude: 80 },
      per_engine_evidence: {
        chatgpt: {
          brand_mentions: 17,
          usable_prompts: 30,
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

test('weekly history aggregates all same-engine scans and separates ISO weeks', async () => {
  const monday = Date.UTC(2026, 0, 5, 8);
  const wednesday = Date.UTC(2026, 0, 7, 14);
  const nextMonday = Date.UTC(2026, 0, 12, 9);
  const history = registerHistoryTool([
    { run_id: 'week1-a', engine: 'chatgpt', completed_at: wednesday, total: 8, hits: 6 },
    { run_id: 'week1-b', engine: 'chatgpt', completed_at: monday, total: 5, hits: 3 },
    { run_id: 'week2', engine: 'chatgpt', completed_at: nextMonday, total: 10, hits: 2 },
  ]);

  const result = await history.handler({ brand_id: 'acme', days: 30, granularity: 'weekly' });
  assert.deepEqual(result.structuredContent.series, [
    {
      date: '2026-01-05',
      overall_score: 69,
      per_engine: { chatgpt: 69 },
      per_engine_evidence: {
        chatgpt: {
          brand_mentions: 9,
          usable_prompts: 13,
          observed_at: new Date(wednesday).toISOString(),
        },
      },
    },
    {
      date: '2026-01-12',
      overall_score: 20,
      per_engine: { chatgpt: 20 },
      per_engine_evidence: {
        chatgpt: {
          brand_mentions: 2,
          usable_prompts: 10,
          observed_at: new Date(nextMonday).toISOString(),
        },
      },
    },
  ]);
});
