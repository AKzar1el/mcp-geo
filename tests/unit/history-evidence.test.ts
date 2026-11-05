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
  }) => Promise<{ structuredContent: {
    series: HistoryPoint[];
    google_search_sampling: null | {
      engines: string[];
      country: 'us';
      language: 'en';
      scope_note: string;
    };
    prompt_set_comparability: {
      changes_detected: boolean;
      changed_engines: string[];
      insufficient_evidence_engines: string[];
      note: string;
    };
  } }>;
};

function registerHistoryTool(
  rows: VisibilityHistoryRow[],
  options: { brandExists?: boolean; onHistoryQuery?: () => void } = {},
): HistoryTool {
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
      getBrand: async () => (options.brandExists === false ? null : { id: 'acme' }),
      getVisibilityHistoryRows: async () => {
        options.onHistoryQuery?.();
        return rows;
      },
    } as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  assert.ok(history, 'get_visibility_history tool registration missing');
  return history;
}

test('visibility history rejects unknown brand IDs without reading history rows', async () => {
  let historyQueries = 0;
  const history = registerHistoryTool([], {
    brandExists: false,
    onHistoryQuery: () => { historyQueries += 1; },
  });
  await assert.rejects(
    history.handler({ brand_id: 'missing', days: 30, granularity: 'weekly' }),
    /brand.*not found/i,
  );
  assert.equal(historyQueries, 0);
});

test('visibility history preserves an empty series for an existing unscanned brand', async () => {
  const history = registerHistoryTool([]);
  const result = await history.handler({ brand_id: 'acme', days: 30, granularity: 'weekly' });
  assert.deepEqual(result.structuredContent.series, []);
  assert.equal(result.structuredContent.google_search_sampling, null);
});

test('visibility history discloses US-English scope when historical Google scans are present', async () => {
  const history = registerHistoryTool([
    { run_id: 'google-1', engine: 'ai_overviews', completed_at: Date.UTC(2026, 0, 5), total: 3, hits: 2 },
    { run_id: 'google-2', engine: 'ai_mode', completed_at: Date.UTC(2026, 0, 5), total: 3, hits: 1 },
    { run_id: 'other', engine: 'chatgpt', completed_at: Date.UTC(2026, 0, 5), total: 3, hits: 2 },
  ]);
  const result = await history.handler({ brand_id: 'acme', days: 30, granularity: 'weekly' });
  assert.deepEqual(result.structuredContent.google_search_sampling?.engines, ['ai_overviews', 'ai_mode']);
  assert.equal(result.structuredContent.google_search_sampling?.country, 'us');
  assert.equal(result.structuredContent.google_search_sampling?.language, 'en');
  assert.match(result.structuredContent.google_search_sampling?.scope_note ?? '', /other markets or languages/);
});

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

test('history detects different complete prompt rosters, not partial scan subsets', async () => {
  const date = Date.UTC(2026, 0, 5);
  const history = registerHistoryTool([
    { run_id: 'a', engine: 'chatgpt', completed_at: date, total: 2, hits: 1,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'old-b,old-a' },
    { run_id: 'b', engine: 'chatgpt', completed_at: date + 1000, total: 1, hits: 0,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'old-a,old-b' },
    { run_id: 'partial', engine: 'claude', completed_at: date, total: 1, hits: 0,
      roster_expected: 2, roster_observed: 1, roster_ids_csv: 'one' },
    { run_id: 'c', engine: 'chatgpt', completed_at: date + 2000, total: 2, hits: 2,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'new-a,new-b' },
  ]);
  const result = await history.handler({
    brand_id: 'acme', days: 30, granularity: 'daily',
  });
  assert.deepEqual(result.structuredContent.prompt_set_comparability, {
    changes_detected: true,
    changed_engines: ['chatgpt'],
    insufficient_evidence_engines: ['claude'],
    note: 'Changes are detected only when complete recorded prompt-ID rosters differ for the same engine. Different prompt sets make historical scores non-comparable; partial or missing rosters cannot establish stability.',
  });
});

test('incomplete rosters do not falsely report a prompt-set change', async () => {
  const date = Date.UTC(2026, 0, 5);
  const history = registerHistoryTool([
    { run_id: 'a', engine: 'chatgpt', completed_at: date, total: 2, hits: 1,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'p1,p2' },
    { run_id: 'partial', engine: 'chatgpt', completed_at: date + 1000, total: 1, hits: 1,
      roster_expected: 2, roster_observed: 1, roster_ids_csv: 'p2' },
  ]);
  const result = await history.handler({
    brand_id: 'acme', days: 30, granularity: 'daily',
  });
  assert.equal(result.structuredContent.prompt_set_comparability.changes_detected, false);
  assert.deepEqual(result.structuredContent.prompt_set_comparability.insufficient_evidence_engines, ['chatgpt']);
});
