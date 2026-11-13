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
    current_identity_only?: boolean;
    active_prompts_only?: boolean;
  }) => Promise<{ structuredContent: {
    series: HistoryPoint[];
    prompt_set_scope: {
      selection: 'full_history' | 'active_only';
      active_prompt_count: number;
      excluded_observations: number;
      note: string;
    };
    identity_scope: {
      selection: 'full_history' | 'current_identity_only';
      excluded_runs: number;
      unknown_start_runs: number;
      note: string;
    };
    measurement_scope: {
      mixed_mode_engines: string[];
      unmeasured_scoped_engines: string[];
      by_engine: Record<string, {
        search_requested: { brand_mentions: number; usable_prompts: number; score: number } | null;
        model_only: { brand_mentions: number; usable_prompts: number; score: number } | null;
      }>;
      by_bucket: Record<string, Record<string, {
        search_requested: { brand_mentions: number; usable_prompts: number; score: number } | null;
        model_only: { brand_mentions: number; usable_prompts: number; score: number } | null;
      }>>;
      note: string;
    };
    google_search_sampling: null | {
      engines: string[];
      country: 'us';
      language: 'en';
      scope_note: string;
    };
    identity_comparability: {
      last_identity_change_at: string | null;
      pre_change_runs: number;
      post_change_runs: number;
      mixes_identity_versions: boolean;
      note: string;
    };
    prompt_set_comparability: {
      changes_detected: boolean;
      changed_engines: string[];
      insufficient_evidence_engines: string[];
      current_active_roster: {
        active_prompt_count: number;
        latest_run_status_by_engine: Record<string, 'matches' | 'differs' | 'unverified'>;
        engines_needing_new_measurement: string[];
        note: string;
      };
      note: string;
    };
  } }>;
};

function registerHistoryTool(
  rows: VisibilityHistoryRow[],
  options: {
    brandExists?: boolean;
    identityChangedAt?: number;
    onHistoryQuery?: (since: number) => void;
    filterBySince?: boolean;
    activePromptIds?: string[];
  } = {},
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
      getBrand: async () => (options.brandExists === false ? null : {
        id: 'acme', identity_changed_at: options.identityChangedAt ?? null,
      }),
      getVisibilityHistoryRows: async (_brandId, since) => {
        options.onHistoryQuery?.(since);
        return options.filterBySince
          ? rows.filter((row) => row.completed_at >= since)
          : rows;
      },
      getActivePrompts: async () => (options.activePromptIds ?? []).map((id) => ({ id })),
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
  assert.deepEqual(result.structuredContent.measurement_scope.mixed_mode_engines, []);
});

test('daily history includes the entire requested UTC calendar-day window', async (t) => {
  const today = Date.UTC(2026, 10, 9);
  t.mock.method(Date, 'now', () => today + 21 * 60 * 60 * 1000);
  const requestedSince: number[] = [];
  const history = registerHistoryTool([
    { run_id: 'yesterday', engine: 'chatgpt', completed_at: today - 10 * 60 * 1000, total: 2, hits: 0 },
    { run_id: 'today-morning', engine: 'chatgpt', completed_at: today + 10 * 60 * 1000, total: 2, hits: 2 },
  ], {
    filterBySince: true,
    onHistoryQuery: (since) => requestedSince.push(since),
  });

  const todayOnly = await history.handler({ brand_id: 'acme', days: 1, granularity: 'daily' });
  assert.equal(requestedSince[0], today, 'one calendar day starts at midnight UTC, not 24 hours ago');
  assert.deepEqual(todayOnly.structuredContent.series.map((row) => row.date), ['2026-11-09']);
  assert.equal(todayOnly.structuredContent.series[0]?.overall_score, 100);

  const bothDays = await history.handler({ brand_id: 'acme', days: 2, granularity: 'daily' });
  assert.equal(requestedSince[1], today - 86_400_000);
  assert.deepEqual(bothDays.structuredContent.series.map((row) => row.date), [
    '2026-11-08', '2026-11-09',
  ]);
});

test('history discloses batch/model-only evidence separately from live search requests', async () => {
  const date = Date.UTC(2026, 0, 5);
  const history = registerHistoryTool([
    { run_id: 'chatgpt-live', engine: 'chatgpt', mode: 'live', completed_at: date, total: 4, hits: 1 },
    { run_id: 'chatgpt-batch', engine: 'chatgpt', mode: 'batch', completed_at: date + 1000, total: 4, hits: 4 },
    { run_id: 'claude-live', engine: 'claude', mode: 'live', completed_at: date + 2000, total: 4, hits: 3 },
  ]);
  const { structuredContent: result } = await history.handler({
    brand_id: 'acme', days: 30, granularity: 'daily',
  });
  assert.equal(result.series[0]?.per_engine.chatgpt, 63, 'legacy combined series remains compatible');
  assert.deepEqual(result.measurement_scope.mixed_mode_engines, ['chatgpt']);
  assert.deepEqual(result.measurement_scope.by_engine, {
    chatgpt: {
      search_requested: { brand_mentions: 1, usable_prompts: 4, score: 25 },
      model_only: { brand_mentions: 4, usable_prompts: 4, score: 100 },
    },
    claude: {
      search_requested: null,
      model_only: { brand_mentions: 3, usable_prompts: 4, score: 75 },
    },
  });
  assert.deepEqual(result.measurement_scope.by_bucket, {
    '2026-01-05': {
      chatgpt: {
        search_requested: { brand_mentions: 1, usable_prompts: 4, score: 25 },
        model_only: { brand_mentions: 4, usable_prompts: 4, score: 100 },
      },
      claude: {
        search_requested: null,
        model_only: { brand_mentions: 3, usable_prompts: 4, score: 75 },
      },
    },
  });
  assert.match(result.measurement_scope.note, /combined.*mode|mode.*combined/i);
});

test('history keeps model-only and search-requested evidence in their own weekly buckets', async () => {
  const history = registerHistoryTool([
    { run_id: 'week1-live', engine: 'chatgpt', mode: 'live', completed_at: Date.UTC(2026, 0, 5), total: 6, hits: 3 },
    { run_id: 'week2-batch', engine: 'chatgpt', mode: 'batch', completed_at: Date.UTC(2026, 0, 12), total: 5, hits: 5 },
    { run_id: 'week2-live', engine: 'chatgpt', mode: 'live', completed_at: Date.UTC(2026, 0, 13), total: 5, hits: 0 },
  ]);
  const { structuredContent: result } = await history.handler({
    brand_id: 'acme', days: 30, granularity: 'weekly',
  });
  assert.deepEqual(result.measurement_scope.by_bucket, {
    '2026-01-05': {
      chatgpt: {
        search_requested: { brand_mentions: 3, usable_prompts: 6, score: 50 },
        model_only: null,
      },
    },
    '2026-01-12': {
      chatgpt: {
        search_requested: { brand_mentions: 0, usable_prompts: 5, score: 0 },
        model_only: { brand_mentions: 5, usable_prompts: 5, score: 100 },
      },
    },
  });
  assert.deepEqual(result.series.map(({ per_engine }) => per_engine.chatgpt), [50, 50],
    'legacy combined bucket scores must remain stable');
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

test('visibility history discloses stored observations spanning an identity edit', async () => {
  const changedAt = Date.UTC(2026, 0, 8);
  const history = registerHistoryTool([
    { run_id: 'old', engine: 'chatgpt', started_at: changedAt - 86_400_000,
      completed_at: changedAt - 86_400_000, total: 2, hits: 2 },
    { run_id: 'new', engine: 'chatgpt', started_at: changedAt + 86_400_000,
      completed_at: changedAt + 86_400_000, total: 2, hits: 0 },
  ], { identityChangedAt: changedAt });
  const result = await history.handler({ brand_id: 'acme', days: 30, granularity: 'weekly' });
  assert.equal(result.structuredContent.identity_comparability.last_identity_change_at, new Date(changedAt).toISOString());
  assert.equal(result.structuredContent.identity_comparability.pre_change_runs, 1);
  assert.equal(result.structuredContent.identity_comparability.post_change_runs, 1);
  assert.equal(result.structuredContent.identity_comparability.mixes_identity_versions, true);
});

test('history attributes a scan to the identity in effect when it started, not when it finished', async () => {
  const changedAt = Date.UTC(2026, 0, 8, 12);
  const history = registerHistoryTool([
    {
      run_id: 'crosses-edit', engine: 'chatgpt',
      started_at: changedAt - 60_000, completed_at: changedAt + 60_000,
      total: 2, hits: 1,
    },
    {
      run_id: 'new-identity', engine: 'chatgpt',
      started_at: changedAt + 120_000, completed_at: changedAt + 180_000,
      total: 2, hits: 0,
    },
  ], { identityChangedAt: changedAt });
  const result = await history.handler({ brand_id: 'acme', days: 30, granularity: 'daily' });
  assert.equal(result.structuredContent.identity_comparability.pre_change_runs, 1);
  assert.equal(result.structuredContent.identity_comparability.post_change_runs, 1);
  assert.equal(result.structuredContent.identity_comparability.mixes_identity_versions, true);
});

test('current-identity history excludes pre-edit and unknown-start evidence without changing historical defaults', async () => {
  const changedAt = Date.UTC(2026, 0, 8, 12);
  const history = registerHistoryTool([
    { run_id: 'old-late', engine: 'chatgpt', started_at: changedAt - 60_000,
      completed_at: changedAt + 60_000, total: 2, hits: 2 },
    { run_id: 'new', engine: 'chatgpt', started_at: changedAt + 120_000,
      completed_at: changedAt + 180_000, total: 2, hits: 0 },
    { run_id: 'unknown', engine: 'chatgpt', completed_at: changedAt + 240_000,
      total: 2, hits: 2 },
  ], { identityChangedAt: changedAt });
  const args = { brand_id: 'acme', days: 30, granularity: 'daily' as const };
  const legacy = (await history.handler(args)).structuredContent;
  assert.equal(legacy.identity_scope.selection, 'full_history');
  assert.equal(legacy.identity_scope.excluded_runs, 0);
  assert.equal(legacy.series[0].overall_score, 67);

  const current = (await history.handler({ ...args, current_identity_only: true })).structuredContent;
  assert.equal(current.identity_scope.selection, 'current_identity_only');
  assert.equal(current.identity_scope.excluded_runs, 2);
  assert.equal(current.identity_scope.unknown_start_runs, 1);
  assert.match(current.identity_scope.note, /run start|identity/i);
  assert.equal(current.series[0].overall_score, 0);
  assert.deepEqual(current.series[0].per_engine_evidence.chatgpt.usable_prompts, 2);
  assert.deepEqual(current.measurement_scope.by_engine.chatgpt.search_requested,
    { brand_mentions: 0, usable_prompts: 2, score: 0 });
  assert.equal(current.identity_comparability.pre_change_runs, 1,
    'historical comparability metadata should still describe the entire requested window');
  assert.equal(current.identity_comparability.post_change_runs, 1,
    'unknown start provenance must not be classified as a post-change run');
});

test('current-identity history preserves unknown-boundary data and returns no fabricated zero when all runs are stale', async () => {
  const changedAt = Date.UTC(2026, 0, 8, 12);
  const old = { run_id: 'old', engine: 'chatgpt', started_at: changedAt - 60_000,
    completed_at: changedAt + 60_000, total: 2, hits: 2 };
  const args = { brand_id: 'acme', days: 30, granularity: 'daily' as const,
    current_identity_only: true };
  const oldOnly = (await registerHistoryTool([old], { identityChangedAt: changedAt })
    .handler(args)).structuredContent;
  assert.deepEqual(oldOnly.series, []);
  assert.deepEqual(oldOnly.measurement_scope.unmeasured_scoped_engines, ['chatgpt'],
    'pre-identity-only evidence must not silently disappear from current-only coverage');
  assert.equal(oldOnly.identity_scope.excluded_runs, 1);
  assert.equal(oldOnly.identity_comparability.pre_change_runs, 1);

  const unknownBoundary = (await registerHistoryTool([old]).handler(args)).structuredContent;
  assert.equal(unknownBoundary.series[0].overall_score, 100);
  assert.equal(unknownBoundary.identity_scope.excluded_runs, 0);
  assert.match(unknownBoundary.identity_scope.note, /no recorded matching-identity boundary/i);
});

test('active-prompt history excludes retired buyer questions before scoring while keeping roster warnings', async () => {
  const date = Date.UTC(2026, 10, 11);
  const history = registerHistoryTool([
    { run_id: 'older', engine: 'chatgpt', mode: 'live', started_at: date,
      completed_at: date, total: 2, hits: 2, active_total: 0, active_hits: 0,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'retired-a,retired-b' },
    { run_id: 'mixed', engine: 'chatgpt', mode: 'live', started_at: date + 1000,
      completed_at: date + 1000, total: 2, hits: 1, active_total: 1, active_hits: 0,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'active,retired-a' },
    { run_id: 'retired-only', engine: 'claude', mode: 'live', started_at: date + 2000,
      completed_at: date + 2000, total: 1, hits: 1, active_total: 0, active_hits: 0,
      roster_expected: 1, roster_observed: 1, roster_ids_csv: 'retired-a' },
  ], { activePromptIds: ['active'] });
  const args = { brand_id: 'acme', days: 30, granularity: 'daily' as const };
  const legacy = (await history.handler(args)).structuredContent;
  assert.equal(legacy.series[0].per_engine.chatgpt, 75);
  assert.equal(legacy.series[0].per_engine.claude, 100);
  assert.deepEqual(legacy.measurement_scope.unmeasured_scoped_engines, []);
  assert.equal(legacy.prompt_set_scope.selection, 'full_history');

  const current = (await history.handler({ ...args, active_prompts_only: true })).structuredContent;
  assert.equal(current.prompt_set_scope.selection, 'active_only');
  assert.equal(current.prompt_set_scope.active_prompt_count, 1);
  assert.equal(current.prompt_set_scope.excluded_observations, 4);
  assert.equal(current.series[0].per_engine.chatgpt, 0);
  assert.equal(current.series[0].per_engine_evidence.chatgpt.usable_prompts, 1);
  assert.equal(current.series[0].per_engine.claude, undefined,
    'an engine with retired-only responses is unmeasured, not scored as zero');
  assert.deepEqual(current.measurement_scope.unmeasured_scoped_engines, ['claude'],
    'active-only history must identify engines with historical but no selected evidence');
  assert.equal(current.measurement_scope.by_engine.chatgpt.search_requested?.usable_prompts, 1);
  assert.equal(current.prompt_set_comparability.current_active_roster.latest_run_status_by_engine.claude,
    'differs', 'retired-only runs still inform the roster mismatch warning');
  assert.match(current.prompt_set_scope.note, /stored|provider/i);

  const noActive = (await registerHistoryTool([
    { run_id: 'retired', engine: 'chatgpt', completed_at: date, total: 2, hits: 2,
      active_total: 0, active_hits: 0 },
  ]).handler({ ...args, active_prompts_only: true })).structuredContent;
  assert.deepEqual(noActive.series, []);
  assert.equal(noActive.prompt_set_scope.active_prompt_count, 0);

  const sameIdentity = (await registerHistoryTool([
    { run_id: 'old', engine: 'chatgpt', started_at: date, completed_at: date,
      total: 2, hits: 2, active_total: 0, active_hits: 0 },
    { run_id: 'new', engine: 'chatgpt', started_at: date + 1000,
      completed_at: date + 1000, total: 2, hits: 1, active_total: 1, active_hits: 0 },
  ], { identityChangedAt: date + 500, activePromptIds: ['active'] })
    .handler({ ...args, current_identity_only: true, active_prompts_only: true })).structuredContent;
  assert.equal(sameIdentity.identity_scope.excluded_runs, 1);
  assert.equal(sameIdentity.prompt_set_scope.excluded_observations, 1);
  assert.equal(sameIdentity.series[0].per_engine.chatgpt, 0,
    'identity and prompt selection must be independently composable');
});

test('history discloses engines excluded by both identity and active-prompt scopes', async () => {
  const changedAt = Date.UTC(2026, 10, 12);
  const history = registerHistoryTool([
    { run_id: 'old-identity', engine: 'chatgpt', started_at: changedAt - 1000,
      completed_at: changedAt - 500, total: 1, hits: 1, active_total: 1, active_hits: 1 },
    { run_id: 'retired-prompts', engine: 'claude', started_at: changedAt + 1000,
      completed_at: changedAt + 2000, total: 1, hits: 1, active_total: 0, active_hits: 0 },
    { run_id: 'current', engine: 'perplexity', started_at: changedAt + 3000,
      completed_at: changedAt + 4000, total: 1, hits: 0, active_total: 1, active_hits: 0 },
  ], { identityChangedAt: changedAt, activePromptIds: ['current'] });
  const result = (await history.handler({ brand_id: 'acme', days: 30, granularity: 'daily',
    current_identity_only: true, active_prompts_only: true })).structuredContent;
  assert.deepEqual(result.measurement_scope.unmeasured_scoped_engines, ['chatgpt', 'claude']);
  assert.deepEqual(Object.keys(result.series[0].per_engine), ['perplexity']);
  assert.equal(result.series[0].per_engine.perplexity, 0,
    'an actual observed loss remains a measured zero');
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
  const comparison = result.structuredContent.prompt_set_comparability;
  assert.deepEqual({
    changes_detected: comparison.changes_detected,
    changed_engines: comparison.changed_engines,
    insufficient_evidence_engines: comparison.insufficient_evidence_engines,
    note: comparison.note,
  }, {
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

test('history identifies stale and unverified latest prompt rosters against active buyer questions', async () => {
  const date = Date.UTC(2026, 0, 5);
  const history = registerHistoryTool([
    { run_id: 'old-only', engine: 'chatgpt', completed_at: date, total: 2, hits: 1,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'old-a,old-b' },
    { run_id: 'claude-old', engine: 'claude', completed_at: date, total: 2, hits: 0,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'old-a,old-b' },
    { run_id: 'claude-new', engine: 'claude', completed_at: date + 2000, total: 2, hits: 1,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'new-b,new-a' },
    { run_id: 'perplexity-new', engine: 'perplexity', completed_at: date, total: 2, hits: 1,
      roster_expected: 2, roster_observed: 2, roster_ids_csv: 'new-a,new-b' },
    { run_id: 'perplexity-partial', engine: 'perplexity', completed_at: date + 3000, total: 1, hits: 1,
      roster_expected: 2, roster_observed: 1, roster_ids_csv: 'new-a' },
  ], { activePromptIds: ['new-a', 'new-b'] });
  const result = await history.handler({ brand_id: 'acme', days: 30, granularity: 'daily' });
  assert.deepEqual(result.structuredContent.prompt_set_comparability.changed_engines, ['claude'],
    'a single old complete roster is not itself a historical prompt-set change');
  assert.deepEqual(result.structuredContent.prompt_set_comparability.current_active_roster, {
    active_prompt_count: 2,
    latest_run_status_by_engine: {
      chatgpt: 'differs',
      claude: 'matches',
      perplexity: 'unverified',
    },
    engines_needing_new_measurement: ['chatgpt'],
    note: 'Most recent completed run per engine is compared with the current active prompt IDs. A differing complete roster needs new measurement; a partial or missing roster is unverified, not proof of current coverage. Historical scores remain unchanged.',
  });
});
