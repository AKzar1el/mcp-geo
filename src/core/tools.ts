// The six shared MCP tools (registerTools) plus the six CLI-only
// management tools (registerLocalManagementTools), registered against
// any McpServer. The shared six are wired verbatim
// between the Cloudflare Worker (src/index.ts) and the local stdio CLI
// (src/cli.ts) — only the Deps wiring differs:
//   - Worker: D1-backed Db, refresh_brand fans out per engine via the
//     SELF service binding (50-subrequest budget per invocation).
//   - CLI: sqlite-backed Db, refresh_brand runs engines inline and
//     sequentially (no subrequest budget locally).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Brand, Db, Prompt, PromptResponse } from '../db/types.js';
import { extractUrls, findTermSetMatchIndex, hostMatchesDomain } from './openai.js';
import {
  ALL_ENGINES,
  getAvailableEngines,
  isEngineName,
  uniqueEngineNames,
  type EngineKeys,
  type EngineName,
  type RunEnginesResult,
} from './engines.js';
import {
  analyzeContentGaps,
  buildFallbackRecommendations,
  type LosingPromptSummary,
} from './content-gap-analysis.js';
import { computeOverallScore } from './scoring.js';
import { generatePrompts } from './prompt-generation.js';
import { applyExactPromptSet } from './prompt-set.js';
import { seedBrand } from './seed.js';
import { updateTrackedBrand } from './update-brand.js';
import {
  normalizeCompetitorDomains,
  normalizeRequiredDomain,
} from './domain.js';

const BRAND_NOT_FOUND_MESSAGE =
  'Brand not found. Create it first: use the track_brand tool (local CLI), or POST /admin/seed on a Cloudflare Workers deployment.';

const ENGINE_NAMES = [
  'chatgpt',
  'claude',
  'perplexity',
  'gemini',
  'grok',
  'ai_overviews',
  'ai_mode',
] as const;

const engineSchema = z.enum(ENGINE_NAMES);

const GOOGLE_SEARCH_SCOPE_NOTE =
  'Google AI Overviews and AI Mode are sampled using US location (gl=us) and English interface (hl=en); results do not establish visibility in other markets or languages.';

const googleSearchSamplingSchema = z.object({
  engines: z.array(z.string()),
  country: z.literal('us'),
  language: z.literal('en'),
  scope_note: z.string(),
}).nullable();

function googleSearchSampling(engines: readonly string[]) {
  const googleEngines = [...new Set(engines.filter(
    (engine) => engine === 'ai_overviews' || engine === 'ai_mode',
  ))];
  return googleEngines.length === 0 ? null : {
    engines: googleEngines,
    country: 'us' as const,
    language: 'en' as const,
    scope_note: GOOGLE_SEARCH_SCOPE_NOTE,
  };
}

// Current Claude/Gemini adapters do not request web search. OpenAI Batch
// outputs also lack the live web-search request made by the ChatGPT adapter.
// This describes the request path, not a guarantee that a provider supplied
// independently verifiable citations for every prompt.
function visibilityMeasurementMode(
  engine: string,
  runMode: 'live' | 'batch',
): 'model_only' | 'search_requested' {
  return runMode === 'batch' || engine === 'claude' || engine === 'gemini'
    ? 'model_only'
    : 'search_requested';
}

const winningPromptOutputSchema = z.object({
  prompt: z.string(),
  engines_cited_in: z.array(z.string()),
  engines_mentioned_in: z.array(z.string()),
  engines_with_brand_link: z.array(z.string()),
});

const losingPromptOutputSchema = z.object({
  prompt: z.string(),
  competitors_cited: z.array(z.string()),
});

const contentGapRecommendationOutputSchema = z.object({
  priority: z.number().int().min(1).max(5),
  topic: z.string(),
  rationale: z.string(),
  suggested_format: z.enum([
    'comparison_page',
    'listicle',
    'how_to_guide',
    'faq_page',
    'case_study',
    'pricing_page',
    'integration_landing_page',
  ]),
});

const visibilityOutputSchema = z.object({
  brand: z.object({
    id: z.string(),
    name: z.string(),
    domain: z.string(),
    category: z.string().nullable(),
  }),
  refreshed_at: z.string(),
  overall_score: z.number(),
  missing_requested_engines: z.array(z.string()),
  measurement_scope: z.object({
    search_requested: z.object({
      score: z.number().nullable(),
      engines: z.array(z.string()),
    }),
    model_only: z.object({
      score: z.number().nullable(),
      engines: z.array(z.string()),
    }),
    mixed_modes: z.boolean(),
    note: z.string(),
  }),
  google_search_sampling: googleSearchSamplingSchema,
  freshness: z.object({
    oldest_refreshed_at: z.string(),
    newest_refreshed_at: z.string(),
    age_spread_hours: z.number(),
    mixed_age_warning: z.boolean(),
    older_engines: z.array(z.string()),
  }),
  prompt_set_comparability: z.object({
    active_prompt_count: z.number(),
    engines_with_retired_prompt_evidence: z.array(z.string()),
    historical_prompt_warning: z.boolean(),
    note: z.string(),
  }),
  configuration_comparability: z.object({
    brand_updated_at: z.string(),
    engines_scanned_before_update: z.array(z.string()),
    historical_settings_warning: z.boolean(),
    note: z.string(),
  }),
  per_engine: z.array(
    z.object({
      engine: z.string(),
      measurement_mode: z.enum(['search_requested', 'model_only']),
      score: z.number(),
      prompts_appeared_in: z.number(),
      total_prompts: z.number(),
      refreshed_at: z.string(),
      coverage: z.object({
        usable_prompts: z.number(),
        expected_prompts: z.number(),
        percent: z.number(),
        partial: z.boolean(),
      }),
    }),
  ),
  top_winning_prompts: z.array(winningPromptOutputSchema),
  winning_prompt_evidence_note: z.string(),
  top_losing_prompts: z.array(losingPromptOutputSchema),
});

const historyOutputSchema = z.object({
  brand_id: z.string(),
  days: z.number(),
  granularity: z.enum(['daily', 'weekly']),
  google_search_sampling: googleSearchSamplingSchema,
  measurement_scope: z.object({
    mixed_mode_engines: z.array(z.string()),
    by_engine: z.record(z.string(), z.object({
      search_requested: z.object({
        brand_mentions: z.number(),
        usable_prompts: z.number(),
        score: z.number(),
      }).nullable(),
      model_only: z.object({
        brand_mentions: z.number(),
        usable_prompts: z.number(),
        score: z.number(),
      }).nullable(),
    })),
    note: z.string(),
  }),
  prompt_set_comparability: z.object({
    changes_detected: z.boolean(),
    changed_engines: z.array(z.string()),
    insufficient_evidence_engines: z.array(z.string()),
    note: z.string(),
  }),
  series: z.array(
    z.object({
      date: z.string(),
      overall_score: z.number(),
      per_engine: z.record(z.string(), z.number()),
      per_engine_evidence: z.record(
        z.string(),
        z.object({
          brand_mentions: z.number(),
          usable_prompts: z.number(),
          observed_at: z.string(),
        }),
      ),
    }),
  ),
});

const comparedPromptOutputSchema = z.object({
  prompt: z.string(),
  you_cited_by: z.array(z.string()),
  competitors_cited: z.array(z.string()),
});

const COMPARISON_SEMANTICS =
  'Legacy prompts_you_win includes all brand-mentioned prompts, including co-mentions. ' +
  'prompts_brand_only and prompts_co_mentioned classify individual engine responses; ' +
  'a prompt can occur in both when engines differ. ' +
  'prompts_won_against_you lists competitor mentions where the tracked brand is absent.';

const COMPARISON_HISTORY_CAVEAT =
  'Competitor mentions were captured using the competitor list configured at scan time. ' +
  'Changing that list does not re-evaluate historical responses; a zero for a newly added ' +
  'competitor may mean it was not tracked, not that it was absent from AI answers. ' +
  'The current configuration cannot prove which competitors were tracked in past scans.';

const compareOutputSchema = z.object({
  brand_id: z.string(),
  days: z.number(),
  comparison_semantics: z.string(),
  historical_coverage_note: z.string(),
  outside_current_tracking: z.array(z.string()),
  your_share_of_voice_pct: z.number(),
  your_mentions: z.number(),
  competitors: z.array(
    z.object({
      domain: z.string(),
      share_of_voice_pct: z.number(),
      mentions: z.number(),
      prompts_won_against_you: z.array(z.string()),
    }),
  ),
  prompts_you_win: z.array(comparedPromptOutputSchema),
  prompts_brand_only: z.array(comparedPromptOutputSchema),
  prompts_co_mentioned: z.array(comparedPromptOutputSchema),
  requested_competitor_domains: z.array(z.string()).nullable(),
});

const citationsOutputSchema = z.object({
  brand_id: z.string(),
  days: z.number(),
  engine: z.string().nullable(),
  google_search_sampling: googleSearchSamplingSchema,
  limit: z.number().int(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  top_sources: z.array(
    z.object({
      domain: z.string(),
      citation_count: z.number(),
      prompt_count: z.number(),
      engines: z.array(z.string()),
      sample_url: z.string(),
      is_brand_domain: z.boolean(),
    }),
  ),
  citations: z.array(
    z.object({
      id: z.string(),
      engine: z.string(),
      prompt: z.string(),
      cited_at: z.string(),
      citation_type: z.string(),
      response_excerpt: z.string(),
      cited_url: z.string().nullable(),
      url_source: z.enum(['provider_source', 'answer_text']).nullable(),
    }),
  ),
});

const citationCursorSchema = z.object({
  v: z.literal(1),
  brand_id: z.string(),
  days: z.number().int(),
  engine: z.string().nullable(),
  since: z.number().int(),
  until: z.number().int(),
  before: z.object({
    captured_at: z.number().int(),
    run_id: z.string(),
    prompt_id: z.string(),
  }),
});

const CITATION_CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CITATION_DAY_MS = 86_400_000;

function decodeCitationCursor(cursor: string, brandId: string, days: number, engine: string | null) {
  try {
    const parsed = citationCursorSchema.parse(JSON.parse(decodeURIComponent(cursor)));
    const now = Date.now();
    // Cursor parameters are client-controlled, not authenticated. Never allow
    // one to expand a requested 1-90-day citation query into an unbounded scan
    // or to select an arbitrary older historical window.
    if (parsed.brand_id !== brandId || parsed.days !== days || parsed.engine !== engine ||
      !Number.isSafeInteger(parsed.since) || !Number.isSafeInteger(parsed.until) ||
      !Number.isSafeInteger(parsed.before.captured_at) ||
      parsed.until > now || parsed.until < now - CITATION_CURSOR_MAX_AGE_MS ||
      parsed.since !== parsed.until - days * CITATION_DAY_MS ||
      parsed.before.captured_at < parsed.since ||
      parsed.before.captured_at > parsed.until) {
      throw new Error('Mismatched cursor scope');
    }
    return parsed;
  } catch {
    throw new Error('Invalid citation cursor. Start again without cursor or use the unchanged brand, days and engine.');
  }
}

const contentGapsOutputSchema = z.object({
  brand_id: z.string(),
  recommendations: z.array(contentGapRecommendationOutputSchema),
  prompt_source: z.enum(['generated', 'fallback']),
  reason: z.string().optional(),
});

const refreshOutputSchema = z.object({
  brand_id: z.string(),
  message: z.string(),
  run_ids: z.record(z.string(), z.string()),
  skipped_unconfigured_engines: z.array(z.string()),
  estimated_completion_seconds: z.number(),
});

const trackBrandOutputSchema = z.object({
  seeded: z.boolean(),
  brand_id: z.string(),
  reason: z.string().optional(),
  prompts_inserted: z.number().optional(),
  prompt_source: z.enum(['generated', 'fallback']).optional(),
  starter_prompt_limitations: z.string().optional(),
  domain: z.string().optional(),
  competitors: z.array(z.string()).optional(),
  refresh_frequency: z.enum(['daily', 'weekly', 'manual']).optional(),
  next_steps: z.string(),
});

const updateBrandOutputSchema = z.object({
  updated: z.boolean(),
  brand_id: z.string(),
  changed_fields: z.array(z.string()),
  prompt_set_review_recommended: z.boolean(),
  historical_attribution_review_recommended: z.boolean(),
  brand: z.object({
    name: z.string(),
    domain: z.string(),
    category: z.string().nullable(),
    competitors: z.array(z.string()),
    aliases: z.array(z.string()),
    exclude_terms: z.array(z.string()),
    refresh_frequency: z.enum(['daily', 'weekly', 'manual']),
  }),
  next_steps: z.string(),
});

const listBrandsOutputSchema = z.object({
  brands: z.array(
    z.object({
      brand_id: z.string(),
      name: z.string(),
      domain: z.string(),
      category: z.string().nullable(),
      competitors: z.array(z.string()),
      aliases: z.array(z.string()),
      exclude_terms: z.array(z.string()),
      refresh_frequency: z.string(),
      active_prompts: z.number(),
      created_at: z.string(),
    }),
  ),
  hint: z.string().optional(),
});

const listPromptsOutputSchema = z.object({
  brand_id: z.string(),
  prompts: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      intent_stage: z.string().nullable(),
      shape: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
  count: z.number(),
});

const setPromptsOutputSchema = z.object({
  brand_id: z.string(),
  prompts_inserted: z.number(),
  prompts: z.array(z.string()),
  changed: z.boolean(),
  next_steps: z.string(),
});

const generatePromptsOutputSchema = z.object({
  brand_id: z.string(),
  prompts_inserted: z.number(),
  prompt_source: z.literal('generated'),
  prompts: z.array(z.string()),
  next_steps: z.string(),
});

const HOSTED_TOOL_NAMES = {
  check_visibility: 'visibility.check',
  get_visibility_history: 'visibility.history',
  compare_competitors: 'visibility.compare',
  get_citations: 'visibility.citations',
  get_content_gaps: 'visibility.content_gaps',
  refresh_brand: 'visibility.refresh',
} as const;

function toolResult(payload: Record<string, unknown>) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}

export interface Deps {
  db: Db;
  env: EngineKeys;
  refreshExecution: 'async' | 'sync';
  // Runs one refresh per engine and returns the run ids. The Worker
  // implementation dispatches each engine into its own invocation via
  // the SELF service binding, while the CLI implementation runs each
  // engine to completion before returning.
  runEnginesInline: (
    brand: Brand,
    prompts: Prompt[],
    engines: EngineName[],
  ) => Promise<RunEnginesResult>;
}

function filterRequestedEngines(
  env: EngineKeys,
  requested: EngineName[] | undefined,
): EngineName[] {
  const available = new Set(getAvailableEngines(env));
  if (!requested || requested.length === 0) return [...available];
  return uniqueEngineNames(requested).filter((e) => available.has(e));
}

export interface ToolRegistrationOptions {
  namespaced?: boolean;
}

export function registerTools(
  server: McpServer,
  deps: Deps,
  options: ToolRegistrationOptions = {},
): void {
  const toolName = (legacyName: keyof typeof HOSTED_TOOL_NAMES) =>
    options.namespaced ? HOSTED_TOOL_NAMES[legacyName] : legacyName;
  const refreshIsAsync = deps.refreshExecution === 'async';
  const refreshCostNote = ' Provider API requests may incur charges. Retries rerun every active prompt, including prior successes.';
  const refreshDescription = refreshIsAsync
    ? "Start fresh scans on selected engines; returns run IDs immediately." + refreshCostNote + " Example: brand_id='acme', engines=['chatgpt','gemini']."
    : "Scan selected engines and return after completion." + refreshCostNote + " Example: brand_id='acme', engines=['chatgpt','gemini'].";

  server.registerTool(
    toolName('check_visibility'),
    {
      title: 'Check AI visibility',
      description:
        "Read stored visibility scores and missing requested engines. Scores omit engines without usable scans; refresh_brand updates data. Example: brand_id='acme', engines=['chatgpt','gemini'].",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to inspect.'),
        engines: z
          .array(engineSchema)
          .optional()
          .describe('Engines to include; omit or pass [] for all stored engines.'),
      },
      outputSchema: visibilityOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, engines }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }

      // getLatestCompletedRun anchors on EXISTS(ok rows) rather than
      // run.status='completed', so partially-finished runs (killed
      // by the subrequest cap, wall time, etc.) still surface their
      // ok rows. Use completed_at when available, started_at as a
      // fallback for in-progress runs.
      const selectedEngines =
        !engines || engines.length === 0 ? ALL_ENGINES : uniqueEngineNames(engines);
      const selectedResponses: PromptResponse[] = [];
      const refreshedAtByEngine = new Map<string, string>();
      const refreshMsByEngine = new Map<string, number>();
      const startedMsByEngine = new Map<string, number>();
      const expectedPromptsByEngine = new Map<string, number>();
      const observedPromptIdsByEngine = new Map<string, Set<string>>();
      const measurementModeByEngine = new Map<string, 'search_requested' | 'model_only'>();
      let mostRecentTimestamp = 0;
      for (const engine of selectedEngines) {
        const run = await deps.db.getLatestCompletedRun(brand_id, engine);
        if (!run) continue;
        const responses = await deps.db.getResponsesForRun(run.id);
        if (responses.length === 0) continue;
        selectedResponses.push(...responses);
        observedPromptIdsByEngine.set(engine, new Set(responses.map((response) => response.prompt_id)));
        measurementModeByEngine.set(engine, visibilityMeasurementMode(engine, run.mode));
        expectedPromptsByEngine.set(engine, run.prompts_total);
        const ts = run.completed_at ?? run.started_at;
        refreshedAtByEngine.set(engine, new Date(ts).toISOString());
        refreshMsByEngine.set(engine, ts);
        startedMsByEngine.set(engine, run.started_at);
        if (ts > mostRecentTimestamp) mostRecentTimestamp = ts;
      }
      if (selectedResponses.length === 0) {
        throw new Error(
          engines && engines.length > 0
            ? 'No visibility data yet for the selected engines. Call refresh_brand to populate them.'
            : 'No visibility data yet for this brand. Call refresh_brand to populate it.',
        );
      }
      // An explicit multi-engine request can otherwise look complete even
      // when only one engine has usable data and contributes to the score.
      const missingRequestedEngines = engines && engines.length > 0
        ? selectedEngines.filter((engine) => !refreshedAtByEngine.has(engine))
        : [];
      const scored = computeOverallScore(brand, selectedResponses);
      const oldestTimestamp = Math.min(...refreshMsByEngine.values());
      const ageSpreadMs = mostRecentTimestamp - oldestTimestamp;
      // Warn only for materially different observation windows, not minor
      // dispatch delays within a normal multi-engine refresh.
      const mixedAgeCutoffMs = 24 * 60 * 60 * 1000;
      const olderEngines = [...refreshMsByEngine.entries()]
        .filter(([, timestamp]) => mostRecentTimestamp - timestamp >= mixedAgeCutoffMs)
        .map(([engine]) => engine)
        .sort();
      const activePrompts = await deps.db.getActivePrompts(brand_id);
      const activePromptIds = new Set(activePrompts.map((prompt) => prompt.id));
      // Successful rows can be a partial sample. Only *observed* retired IDs
      // prove stale evidence; missing current IDs belong to coverage warnings.
      const retiredPromptEngines = [...observedPromptIdsByEngine.entries()]
        .filter(([, ids]) => [...ids].some((id) => !activePromptIds.has(id)))
        .map(([engine]) => engine)
        .sort();
      // The database stores the latest settings timestamp, not a per-run
      // identity snapshot. Report potentially older scoring evidence without
      // claiming we know which metadata fields actually changed.
      const enginesBeforeBrandUpdate = [...startedMsByEngine.entries()]
        .filter(([, startedAt]) => startedAt < brand.updated_at)
        .map(([engine]) => engine)
        .sort();
      const perEngine = scored.per_engine.map((engine) => {
        // The score is conditional on usable responses. Report its sample
        // coverage explicitly rather than presenting a partial scan as full.
        const expected = Math.max(
          engine.total_prompts,
          expectedPromptsByEngine.get(engine.engine) ?? 0,
        );
        return {
          ...engine,
          measurement_mode: measurementModeByEngine.get(engine.engine)!,
          refreshed_at: refreshedAtByEngine.get(engine.engine)!,
          coverage: {
            usable_prompts: engine.total_prompts,
            expected_prompts: expected,
            percent: expected === 0 ? 100 : Math.round(100 * engine.total_prompts / expected),
            partial: engine.total_prompts < expected,
          },
        };
      });

      const measurementGroup = (mode: 'search_requested' | 'model_only') => {
        const engines = perEngine.filter((engine) => engine.measurement_mode === mode);
        return {
          score: engines.length === 0
            ? null
            : Math.round(engines.reduce((sum, engine) => sum + engine.score, 0) / engines.length),
          engines: engines.map((engine) => engine.engine),
        };
      };
      const searchRequested = measurementGroup('search_requested');
      const modelOnly = measurementGroup('model_only');

      const payload = {
        brand: {
          id: brand.id,
          name: brand.name,
          domain: brand.domain,
          category: brand.category,
        },
        refreshed_at: new Date(mostRecentTimestamp).toISOString(),
        overall_score: scored.overall_score,
        missing_requested_engines: missingRequestedEngines,
        measurement_scope: {
          search_requested: searchRequested,
          model_only: modelOnly,
          mixed_modes: searchRequested.engines.length > 0 && modelOnly.engines.length > 0,
          note: 'Scores count brand mentions in usable responses, not independently verified search citations. Search-requested engines use a live search/SERP request path but may return no source links. Claude and Gemini here use model-only answers; ungrounded batch runs are also model-only. Compare these groups separately, especially before interpreting the combined overall_score.',
        },
        google_search_sampling: googleSearchSampling(perEngine.map(({ engine }) => engine)),
        freshness: {
          oldest_refreshed_at: new Date(oldestTimestamp).toISOString(),
          newest_refreshed_at: new Date(mostRecentTimestamp).toISOString(),
          age_spread_hours: Math.round((ageSpreadMs / 3600000) * 10) / 10,
          mixed_age_warning: olderEngines.length > 0,
          older_engines: olderEngines,
        },
        prompt_set_comparability: {
          active_prompt_count: activePromptIds.size,
          engines_with_retired_prompt_evidence: retiredPromptEngines,
          historical_prompt_warning: retiredPromptEngines.length > 0,
          note: retiredPromptEngines.length > 0
            ? 'Latest scored responses from the listed engines include prompts no longer in the active set. Their scores remain historical observations and should not be compared as measurements of the current prompt set. Partial scan coverage is reported separately.'
            : 'No retired prompt IDs were observed in these scored responses. This does not prove complete coverage of the current prompt set; inspect per-engine coverage separately.',
        },
        configuration_comparability: {
          brand_updated_at: new Date(brand.updated_at).toISOString(),
          engines_scanned_before_update: enginesBeforeBrandUpdate,
          historical_settings_warning: enginesBeforeBrandUpdate.length > 0,
          note: 'Brand settings were updated after the listed engines began their latest scans. Stored responses retain their original scoring and may reflect earlier brand identity, aliases, exclusions, or competitor tracking; the database cannot establish which settings changed. A cadence-only update may not affect the evidence. Review changes and refresh affected engines before relying on current-configuration comparisons.',
        },
        per_engine: perEngine,
        top_winning_prompts: scored.top_winning_prompts,
        winning_prompt_evidence_note: 'engines_cited_in is a legacy field counting brand mentions in answers, not source citations. Use engines_mentioned_in for mention evidence and engines_with_brand_link for linked brand evidence. A link-only source without an answer mention is not a winning prompt.',
        top_losing_prompts: scored.top_losing_prompts,
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    toolName('get_visibility_history'),
    {
      title: 'Get AI visibility history',
      description:
        "Return daily or weekly visibility history with per-engine evidence and model-only versus search-requested measurement scope. Example: brand_id='acme', days=30, granularity='weekly'.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to inspect.'),
        days: z
          .number()
          .min(1)
          .max(365)
          .default(30)
          .describe('Previous calendar days to include.'),
        granularity: z
          .enum(['daily', 'weekly'])
          .default('weekly')
          .describe('Time bucket for the series.'),
      },
      outputSchema: historyOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, days, granularity }) => {
      if (!await deps.db.getBrand(brand_id)) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const since = Date.now() - days * 86_400_000;
      const results = await deps.db.getVisibilityHistoryRows(brand_id, since);

      // Historical runs can contain both ungrounded OpenAI batches and
      // search-requested ChatGPT samples. Preserve the legacy series while
      // reporting their distinct evidence denominators for this time window.
      type Counts = { brand_mentions: number; usable_prompts: number };
      const scopeCounts = new Map<string, {
        search_requested: Counts;
        model_only: Counts;
      }>();
      for (const row of results) {
        const counts = scopeCounts.get(row.engine) ?? {
          search_requested: { brand_mentions: 0, usable_prompts: 0 },
          model_only: { brand_mentions: 0, usable_prompts: 0 },
        };
        const mode = visibilityMeasurementMode(row.engine, row.mode ?? 'live');
        counts[mode].brand_mentions += Number(row.hits ?? 0);
        counts[mode].usable_prompts += Number(row.total ?? 0);
        scopeCounts.set(row.engine, counts);
      }
      const scoredCounts = (counts: Counts) => counts.usable_prompts === 0 ? null : {
        ...counts,
        score: Math.round(100 * counts.brand_mentions / counts.usable_prompts),
      };
      const measurement_scope = {
        mixed_mode_engines: [...scopeCounts.entries()]
          .filter(([, counts]) =>
            counts.search_requested.usable_prompts > 0 && counts.model_only.usable_prompts > 0,
          )
          .map(([engine]) => engine).sort(),
        by_engine: Object.fromEntries([...scopeCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([engine, counts]) => [engine, {
            search_requested: scoredCounts(counts.search_requested),
            model_only: scoredCounts(counts.model_only),
          }])),
        note: 'Combined legacy daily and weekly scores may mix model-only and search-requested run evidence in the same bucket. These window-wide, separately scored denominators identify mixed-mode engines; they do not prove that every search-requested response returned citations.',
      };

      // Only compare complete recorded run rosters. Comparing successful
      // responses alone would falsely flag a change after a partial scan.
      // Prompt IDs are stable while active and change on set_prompts.
      const promptRosters = new Map<string, Set<string>>();
      const incompleteRosters = new Set<string>();
      for (const row of results) {
        const expected = row.roster_expected;
        const observed = row.roster_observed;
        const ids = row.roster_ids_csv?.split(',') ?? [];
        if (
          typeof expected !== 'number' || expected <= 0 ||
          observed !== expected || ids.length !== expected ||
          ids.some((id) => !id)
        ) {
          incompleteRosters.add(row.engine);
          continue;
        }
        const signature = [...ids].sort().join('\u001f');
        const signatures = promptRosters.get(row.engine) ?? new Set<string>();
        signatures.add(signature);
        promptRosters.set(row.engine, signatures);
      }
      const changedEngines = [...promptRosters.entries()]
        .filter(([, signatures]) => signatures.size > 1)
        .map(([engine]) => engine).sort();
      const insufficientEngines = [...new Set(results.map((row) => row.engine))]
        .filter((engine) =>
          incompleteRosters.has(engine) || (promptRosters.get(engine)?.size ?? 0) < 1,
        ).sort();
      const prompt_set_comparability = {
        changes_detected: changedEngines.length > 0,
        changed_engines: changedEngines,
        insufficient_evidence_engines: insufficientEngines,
        note: 'Changes are detected only when complete recorded prompt-ID rosters differ for the same engine. Different prompt sets make historical scores non-comparable; partial or missing rosters cannot establish stability.',
      };

      const buckets = new Map<
        string,
        Map<
          string,
          {
            score: number;
            brand_mentions: number;
            usable_prompts: number;
            observed_at: string;
          }
        >
      >();
      for (const row of results) {
        const date = bucketStart(row.completed_at, granularity);
        const total = Number(row.total ?? 0);
        const hits = Number(row.hits ?? 0);
        let perEngine = buckets.get(date);
        if (!perEngine) {
          perEngine = new Map();
          buckets.set(date, perEngine);
        }
        // Each row represents one run, not an entire bucket. Aggregate the
        // evidence denominator before rounding to avoid losing earlier scans.
        const previous = perEngine.get(row.engine);
        const brand_mentions = (previous?.brand_mentions ?? 0) + hits;
        const usable_prompts = (previous?.usable_prompts ?? 0) + total;
        const observedAt = new Date(row.completed_at).toISOString();
        perEngine.set(row.engine, {
          score: usable_prompts > 0 ? Math.round((100 * brand_mentions) / usable_prompts) : 0,
          brand_mentions,
          usable_prompts,
          observed_at: previous && previous.observed_at > observedAt
            ? previous.observed_at
            : observedAt,
        });
      }
      const series = [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, perEngine]) => {
          const scores = [...perEngine.values()].map((point) => point.score);
          const overall_score =
            scores.length === 0
              ? 0
              : Math.round(
                  scores.reduce((s, x) => s + x, 0) / scores.length,
                );
          return {
            date,
            overall_score,
            per_engine: Object.fromEntries(
              [...perEngine].map(([engine, point]) => [engine, point.score]),
            ),
            per_engine_evidence: Object.fromEntries(
              [...perEngine].map(([engine, point]) => [
                engine,
                {
                  brand_mentions: point.brand_mentions,
                  usable_prompts: point.usable_prompts,
                  observed_at: point.observed_at,
                },
              ]),
            ),
          };
        });

      const payload = {
        brand_id,
        days,
        granularity,
        google_search_sampling: googleSearchSampling(results.map(({ engine }) => engine)),
        measurement_scope,
        prompt_set_comparability,
        series,
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    toolName('compare_competitors'),
    {
      title: 'Compare competitor AI visibility',
      description:
        "Compare recorded brand/competitor mentions, co-mentions and share of voice. New competitors are not retroactively scored. Example: brand_id='acme', competitor_domains=['rival.com'], days=7.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to compare.'),
        competitor_domains: z
          .array(z.string())
          .optional()
          .describe("Competitor domains; omit to use the brand's configured list."),
        days: z
          .number()
          .min(1)
          .max(90)
          .default(7)
          .describe('Previous days to compare.'),
      },
      outputSchema: compareOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, competitor_domains, days }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const targets =
        competitor_domains && competitor_domains.length > 0
          ? normalizeCompetitorDomains(competitor_domains, brand.domain)
          : brand.competitors;
      const outsideCurrentTracking = targets.filter(
        (domain) => !brand.competitors.includes(domain),
      );
      if (targets.length === 0) {
        const payload = {
          brand_id,
          days,
          message:
            'No competitor list configured for this brand. Pass competitor_domains or set brand.competitors.',
          your_share_of_voice_pct: 0,
          your_mentions: 0,
          comparison_semantics: COMPARISON_SEMANTICS,
          historical_coverage_note: COMPARISON_HISTORY_CAVEAT,
          outside_current_tracking: outsideCurrentTracking,
          competitors: [],
          prompts_you_win: [],
          prompts_brand_only: [],
          prompts_co_mentioned: [],
          requested_competitor_domains: competitor_domains ?? null,
        };
        return toolResult(payload);
      }

      const since = Date.now() - days * 86_400_000;
      const allResponses = await deps.db.getResponsesSince(brand_id, since);

      const brandMentions = allResponses.reduce(
        (s, r) => s + (r.brand_mentioned === 1 ? 1 : 0),
        0,
      );
      const competitorMentions = new Map<string, number>();
      for (const target of targets) competitorMentions.set(target, 0);
      for (const r of allResponses) {
        for (const c of r.competitors_mentioned) {
          if (competitorMentions.has(c)) {
            competitorMentions.set(c, (competitorMentions.get(c) ?? 0) + 1);
          }
        }
      }
      const totalMentions =
        brandMentions +
        [...competitorMentions.values()].reduce((s, x) => s + x, 0);
      const pct = (n: number) =>
        totalMentions === 0 ? 0 : Math.round((100 * n) / totalMentions);

      const competitorsOut = targets.map((domain) => {
        const wonPrompts = new Map<string, string>();
        for (const r of allResponses) {
          if (r.brand_mentioned === 1) continue;
          if (!r.competitors_mentioned.includes(domain)) continue;
          if (!wonPrompts.has(r.prompt_id)) {
            wonPrompts.set(r.prompt_id, r.prompt_text);
          }
        }
        const mentions = competitorMentions.get(domain) ?? 0;
        return {
          domain,
          share_of_voice_pct: pct(mentions),
          mentions,
          prompts_won_against_you: [...wonPrompts.values()].slice(0, 5),
        };
      });

      type ComparedPrompt = {
        prompt: string;
        engines: Set<string>;
        competitors: Set<string>;
      };
      const winsByPrompt = new Map<string, ComparedPrompt>();
      const brandOnlyByPrompt = new Map<string, ComparedPrompt>();
      const coMentionedByPrompt = new Map<string, ComparedPrompt>();
      const collectPrompt = (
        map: Map<string, ComparedPrompt>,
        r: PromptResponse,
        mentionedCompetitors: string[],
      ) => {
        const existing = map.get(r.prompt_id);
        if (existing) {
          existing.engines.add(r.engine);
          for (const competitor of mentionedCompetitors) {
            existing.competitors.add(competitor);
          }
        } else {
          map.set(r.prompt_id, {
            prompt: r.prompt_text,
            engines: new Set([r.engine]),
            competitors: new Set(mentionedCompetitors),
          });
        }
      };
      for (const r of allResponses) {
        if (r.brand_mentioned !== 1) continue;
        const mentioned = r.competitors_mentioned.filter((c) => targets.includes(c));
        collectPrompt(winsByPrompt, r, mentioned);
        // Keep legacy inclusive mentions while exposing unambiguous per-response cohorts.
        collectPrompt(mentioned.length > 0 ? coMentionedByPrompt : brandOnlyByPrompt, r, mentioned);
      }
      const topPrompts = (map: Map<string, ComparedPrompt>) => [...map.values()]
        .sort((a, b) => b.engines.size - a.engines.size)
        .slice(0, 5)
        .map((w) => ({
          prompt: w.prompt,
          you_cited_by: [...w.engines].sort(),
          competitors_cited: [...w.competitors].sort(),
        }));
      const prompts_you_win = topPrompts(winsByPrompt);
      const prompts_brand_only = topPrompts(brandOnlyByPrompt);
      const prompts_co_mentioned = topPrompts(coMentionedByPrompt);

      const payload = {
        brand_id,
        days,
        your_share_of_voice_pct: pct(brandMentions),
        your_mentions: brandMentions,
        comparison_semantics: COMPARISON_SEMANTICS,
        historical_coverage_note: COMPARISON_HISTORY_CAVEAT,
        outside_current_tracking: outsideCurrentTracking,
        competitors: competitorsOut,
        prompts_you_win,
        prompts_brand_only,
        prompts_co_mentioned,
        requested_competitor_domains: competitor_domains ?? null,
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    toolName('get_citations'),
    {
      title: 'Get AI citation evidence',
      description:
        "Return paginated brand mentions and link-only evidence with genuine URL provenance and top source domains. Continue with next_cursor within 24 hours; restart without a cursor after it expires. Example: brand_id='acme', days=14.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to inspect.'),
        days: z
          .number()
          .min(1)
          .max(90)
          .default(14)
          .describe('Previous days to search.'),
        engine: engineSchema
          .optional()
          .describe('Engine to filter by; omit for all engines.'),
        limit: z.number().int().min(1).max(100).default(50)
          .describe('Citation rows per page, 1-100 (default 50).'),
        cursor: z.string().max(1600).optional()
          .describe('Opaque next_cursor from prior page; preserve brand, days and engine.'),
      },
      outputSchema: citationsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, days = 14, engine, limit = 50, cursor }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const now = Date.now();
      const previous = cursor ? decodeCitationCursor(cursor, brand_id, days, engine ?? null) : null;
      const since = previous?.since ?? (now - days * 86_400_000);
      const until = previous?.until ?? now;
      // Query one extra row to tell the caller whether another page exists.
      const rows = await deps.db.getCitationRows(brand_id, since, engine, {
        until,
        before: previous?.before,
        limit: limit + 1,
      });
      const hasMore = rows.length > limit;
      const results = rows.slice(0, limit);
      const sourceResponses = (await deps.db.getResponsesSince(brand_id, since)).filter(
        (response) => response.captured_at <= until && (!engine || response.engine === engine),
      );

      const citations = results.map((row) => {
        const engineHosts = parseStringArray(row.engine_citations_json);
        const brandUrl = pickBrandUrl(brand, engineHosts, row.raw_response);
        return {
          id: citationId(row.run_id, row.prompt_id),
          engine: row.engine,
          prompt: row.prompt,
          cited_at: new Date(row.captured_at).toISOString(),
          citation_type:
            row.brand_mentioned !== 1 && row.brand_cited_with_link === 1
              ? 'source_link_only'
              : row.brand_cited_with_link === 1
              ? 'mention_with_link'
              : 'mention_without_link',
          response_excerpt: buildResponseExcerpt(row.raw_response, brand),
          cited_url: brandUrl?.url ?? null,
          url_source: brandUrl?.source ?? null,
        };
      });

      const payload = {
        brand_id,
        days,
        engine: engine ?? null,
        google_search_sampling: googleSearchSampling([
          ...(engine ? [engine] : []),
          ...sourceResponses.map(({ engine: sourceEngine }) => sourceEngine),
          ...results.map(({ engine: citationEngine }) => citationEngine),
        ]),
        limit,
        has_more: hasMore,
        next_cursor: hasMore && results.length > 0
          ? encodeURIComponent(JSON.stringify({
              v: 1,
              brand_id,
              days,
              engine: engine ?? null,
              since,
              until,
              before: {
                captured_at: results[results.length - 1].captured_at,
                run_id: results[results.length - 1].run_id,
                prompt_id: results[results.length - 1].prompt_id,
              },
            }))
          : null,
        top_sources: buildTopSources(sourceResponses, brand),
        citations,
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    toolName('get_content_gaps'),
    {
      title: 'Find AI visibility content gaps',
      description:
        "Prioritize observed competitor-winning prompts. Provider-free by default; ai_analysis=true opts in to token-billed Claude (may retry once). Example: brand_id='acme'.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to analyze.'),
        max_recommendations: z
          .number()
          .min(1)
          .max(10)
          .default(5)
          .describe('Maximum recommendations to return.'),
        ai_analysis: z
          .boolean()
          .default(false)
          .describe('True: token-billed Claude analysis (may retry once). False: provider-free fallback.'),
      },
      outputSchema: contentGapsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ brand_id, max_recommendations, ai_analysis }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }

      const losingByPrompt = new Map<
        string,
        {
          prompt_text: string;
          engines: Set<string>;
          competitors: Set<string>;
        }
      >();
      for (const engine of ALL_ENGINES) {
        const run = await deps.db.getLatestCompletedRun(brand_id, engine);
        if (!run) continue;
        const responses = await deps.db.getResponsesForRun(run.id);
        for (const r of responses) {
          if (r.brand_mentioned !== 0) continue;
          if (r.competitors_mentioned.length === 0) continue;
          const existing = losingByPrompt.get(r.prompt_id);
          if (existing) {
            existing.engines.add(r.engine);
            for (const c of r.competitors_mentioned) {
              existing.competitors.add(c);
            }
          } else {
            losingByPrompt.set(r.prompt_id, {
              prompt_text: r.prompt_text,
              engines: new Set([r.engine]),
              competitors: new Set(r.competitors_mentioned),
            });
          }
        }
      }
      const losingPrompts: LosingPromptSummary[] = [...losingByPrompt.values()]
        .map((l) => ({
          prompt_text: l.prompt_text,
          engines_lost_on: [...l.engines].sort(),
          competitors_winning: [...l.competitors].sort(),
        }))
        .sort(
          (a, b) =>
            b.competitors_winning.length - a.competitors_winning.length,
        )
        .slice(0, 15);

      if (losingPrompts.length === 0) {
        const payload = {
          brand_id,
          recommendations: [],
          prompt_source: 'fallback' as const,
          reason:
            'no losing prompts yet — collect more data first (run refresh_brand, then re-check competitors)',
        };
        return toolResult(payload);
      }

      let recommendations = buildFallbackRecommendations(losingPrompts, max_recommendations);
      let prompt_source: 'generated' | 'fallback' = 'fallback';
      let fallbackReason: string | undefined;
      if (ai_analysis) {
        if (!deps.env.ANTHROPIC_API_KEY?.trim()) {
          fallbackReason = 'AI analysis requested but ANTHROPIC_API_KEY is not configured; returning provider-free recommendations.';
        } else {
          try {
            recommendations = await analyzeContentGaps(
              { ANTHROPIC_API_KEY: deps.env.ANTHROPIC_API_KEY },
              brand,
              losingPrompts,
              max_recommendations,
            );
            prompt_source = 'generated';
          } catch (err) {
            console.warn('get_content_gaps: analyzer failed, returning fallback', {
              brand_id,
              message: err instanceof Error ? err.message : String(err),
            });
            fallbackReason = 'AI analysis requested but failed; returning provider-free recommendations. Anthropic requests may still be billed.';
          }
        }
      }

      const payload = {
        brand_id,
        recommendations,
        prompt_source,
        ...(fallbackReason ? { reason: fallbackReason } : {}),
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    toolName('refresh_brand'),
    {
      title: 'Refresh AI visibility scan',
      description: refreshDescription,
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to refresh.'),
        engines: z
          .array(engineSchema)
          .optional()
          .describe('Engines to run; omit for every configured engine.'),
      },
      outputSchema: refreshOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ brand_id, engines }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const prompts = await deps.db.getActivePrompts(brand_id);
      if (prompts.length === 0) {
        throw new Error(
          'Brand has no active prompts. Run the generate_prompts tool (local CLI) or POST /admin/generate-prompts (Workers deployment).',
        );
      }
      const requested = engines as EngineName[] | undefined;
      if (requested) {
        const unknown = requested.filter((e) => !isEngineName(e));
        if (unknown.length > 0) {
          throw new Error(
            `Unknown engines: ${unknown.join(', ')}. Allowed: ${ALL_ENGINES.join(', ')}`,
          );
        }
      }
      const filtered = filterRequestedEngines(deps.env, requested);
      const skippedUnconfigured = requested && requested.length > 0
        ? uniqueEngineNames(requested).filter((engine) => !filtered.includes(engine))
        : [];
      if (filtered.length === 0) {
        if (requested && requested.length > 0) {
          throw new Error(
            `Requested engines are not configured: ${uniqueEngineNames(requested).join(', ')}. Configure the matching provider API key (and SERPAPI_AI_MODE_ENABLED=true for Google AI Mode), or omit engines to refresh every configured engine.`,
          );
        }
        throw new Error(
          'No engines available. Set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, XAI_API_KEY, SERPAPI_API_KEY. Google AI Mode additionally requires SERPAPI_AI_MODE_ENABLED=true.',
        );
      }
      const { run_ids, engines: kicked } = await deps.runEnginesInline(
        brand,
        prompts,
        filtered,
      );
      const alreadyRunning = Object.keys(run_ids).length - kicked.length;
      const payload = {
        brand_id: brand.id,
        message: `Refresh ${refreshIsAsync ? 'started' : 'completed'} for ${kicked.length} engine${kicked.length === 1 ? '' : 's'}` +
          (alreadyRunning > 0
            ? `; ${alreadyRunning} engine${alreadyRunning === 1 ? '' : 's'} already in progress (existing run IDs reused)`
            : '') +
          (skippedUnconfigured.length > 0 ? `; skipped unconfigured: ${skippedUnconfigured.join(', ')}` : ''),
        run_ids,
        skipped_unconfigured_engines: skippedUnconfigured,
        estimated_completion_seconds: refreshIsAsync ? 30 : 0,
      };
      return toolResult(payload);
    },
  );
}

export interface ManagementDeps {
  db: Db;
  env: EngineKeys;
}

// Local brand-management tools, registered ONLY by the stdio CLI
// (src/cli.ts). The Worker deliberately does not expose these over MCP:
// on a hosted deployment, brand creation and prompt regeneration stay
// behind the X-Seed-Secret-gated /admin/* routes. Hosted MCP access
// requires the independent CONNECT_SECRET OAuth authorization gate.
export function registerLocalManagementTools(
  server: McpServer,
  deps: ManagementDeps,
): void {
  server.registerTool(
    'track_brand',
    {
      title: 'Track a brand',
      description:
        "Track a brand with 3 provider-free starter prompts. Set prompt_generation='anthropic' for paid Claude generation (may retry). Example: brand_id='acme', name='Acme', domain='acme.com'.",
      inputSchema: {
        brand_id: z
          .string()
          .describe("New stable brand ID, e.g. 'acme'.")
          .regex(
            /^[a-z0-9][a-z0-9_-]{0,63}$/i,
            'brand_id must be 1-64 characters: letters, digits, hyphens, underscores (e.g. "acme")',
          ),
        name: z
          .string()
          .min(1)
          .max(200)
          .describe('Brand display name.'),
        domain: z
          .string()
          .min(3)
          .max(253)
          .describe("Primary domain, e.g. 'acme.com'."),
        category: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Market/category for prompt generation.'),
        competitors: z
          .array(z.string().min(3).max(253))
          .max(20)
          .optional()
          .describe('Competitor domains to compare.'),
        aliases: z
          .array(z.string().min(1).max(100))
          .max(20)
          .optional()
          .describe('Additional names that count as brand mentions.'),
        exclude_terms: z
          .array(z.string().min(1).max(100))
          .max(20)
          .optional()
          .describe('Bare terms to ignore in mention matching; the full domain still matches.'),
        prompt_count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Prompt count for explicit Anthropic generation.'),
        prompt_generation: z
          .enum(['fallback', 'anthropic'])
          .default('fallback')
          .describe('Free fallback by default; anthropic allows token-billed Claude and one retry.'),
        refresh_frequency: z
          .enum(['daily', 'weekly', 'manual'])
          .default('weekly')
          .describe(
            "Worker cron cadence; 'manual' disables cron scans. Local stdio stores this setting only.",
          ),
      },
      outputSchema: trackBrandOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      brand_id,
      name,
      domain,
      category,
      competitors,
      aliases,
      exclude_terms,
      prompt_count,
      prompt_generation,
      refresh_frequency,
    }) => {
      const normalizedDomain = normalizeRequiredDomain(domain);
      const normalizedCompetitors = normalizeCompetitorDomains(
        competitors ?? [],
        normalizedDomain,
      );

      const result = await seedBrand(
        { db: deps.db, ANTHROPIC_API_KEY: deps.env.ANTHROPIC_API_KEY },
        {
          brand_id,
          name,
          domain: normalizedDomain,
          category,
          competitors: normalizedCompetitors,
          aliases,
          exclude_terms,
          prompt_generation,
          refresh_frequency,
        },
        prompt_count,
      );

      let next_steps: string;
      if (result.seeded) {
        next_steps =
          result.prompt_source === 'fallback'
            ? category?.trim()
              ? `Tracked with ${result.prompts_inserted} provider-free category-anchored starter prompts. Review list_prompts and customize with set_prompts for representative buyer questions before interpreting scores. Call refresh_brand with brand_id '${result.brand_id}' for a starter scan; paid generate_prompts remains optional.`
              : `Tracked with ${result.prompts_inserted} limited starter prompts. No category was supplied, so these prompts use your brand name and can bias visibility scores. Set a category with update_brand and supply independent category prompts with set_prompts before refresh_brand.`
            : `Call refresh_brand with brand_id '${result.brand_id}' to run the first scan, then check_visibility for the results.`;
      } else if (result.reason === 'already exists') {
        next_steps = `Brand '${result.brand_id}' is already tracked — nothing was changed. Use list_brands to inspect it, update_brand to correct its metadata, or generate_prompts to refresh its prompt set.`;
      } else {
        next_steps =
          'Nothing was created — brand_id, name, and domain are all required.';
      }

      const payload = {
        ...result,
        domain: result.seeded ? normalizedDomain : undefined,
        competitors: result.seeded ? normalizedCompetitors : undefined,
        refresh_frequency: result.seeded ? refresh_frequency : undefined,
        next_steps,
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    'update_brand',
    {
      title: 'Update tracked brand',
      description:
        "Change tracked-brand metadata without replacing prompts or history. Example: brand_id='acme', competitors=['rival.com'], refresh_frequency='manual' pauses cron scans but keeps manual refresh.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to update.'),
        name: z.string().min(1).max(200).optional().describe('New display name.'),
        domain: z.string().min(3).max(253).optional().describe('New primary domain.'),
        category: z
          .string()
          .min(1)
          .max(200)
          .nullable()
          .optional()
          .describe('New category, or null to clear it.'),
        competitors: z
          .array(z.string().min(3).max(253))
          .max(20)
          .optional()
          .describe('Replacement competitor domains.'),
        aliases: z
          .array(z.string().min(1).max(100))
          .max(20)
          .optional()
          .describe('Replacement mention aliases.'),
        exclude_terms: z
          .array(z.string().min(1).max(100))
          .max(20)
          .optional()
          .describe('Replacement bare terms to ignore in mention matching.'),
        refresh_frequency: z
          .enum(['daily', 'weekly', 'manual'])
          .optional()
          .describe("New cadence; 'manual' pauses cron scans."),
      },
      outputSchema: updateBrandOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      brand_id,
      name,
      domain,
      category,
      competitors,
      aliases,
      exclude_terms,
      refresh_frequency,
    }) => {
      const result = await updateTrackedBrand(deps.db, {
        brand_id,
        name,
        domain,
        category,
        competitors,
        aliases,
        exclude_terms,
        refresh_frequency,
      });
      const payload = {
        updated: result.updated,
        brand_id: result.brand_id,
        changed_fields: result.changed_fields,
        prompt_set_review_recommended: result.prompt_set_review_recommended,
        historical_attribution_review_recommended: result.historical_attribution_review_recommended,
        brand: {
          name: result.brand.name,
          domain: result.brand.domain,
          category: result.brand.category,
          competitors: result.brand.competitors,
          aliases: result.brand.aliases,
          exclude_terms: result.brand.exclude_terms,
          refresh_frequency: result.brand.refresh_frequency,
        },
        next_steps: [
          result.prompt_set_review_recommended
            ? `Category changed, but active prompts and historical runs were preserved. Review list_prompts and use set_prompts to replace outdated buyer-intent prompts before calling refresh_brand for '${brand_id}'. generate_prompts uses a paid API and is optional.`
            : `Call refresh_brand with brand_id '${brand_id}' to scan using the updated metadata. Active prompts and historical runs were preserved.`,
          ...(result.historical_attribution_review_recommended
            ? ['Brand matching identity changed. Historical visibility scores were measured under the previous name/domain/aliases/exclusions and must not be treated as directly comparable to new scans; retain prior evidence and establish a new baseline.']
            : []),
        ].join(' '),
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    'list_brands',
    {
      title: 'List tracked brands',
      description:
        'List tracked brands with metadata and active-prompt counts. Example: call before other tools when you need a brand_id.',
      inputSchema: {},
      outputSchema: listBrandsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const brands = await deps.db.listBrands();
      const payload = {
        brands: brands.map((b) => ({
          brand_id: b.id,
          name: b.name,
          domain: b.domain,
          category: b.category,
          competitors: b.competitors,
          aliases: b.aliases,
          exclude_terms: b.exclude_terms,
          refresh_frequency: b.refresh_frequency,
          active_prompts: b.active_prompts,
          created_at: new Date(b.created_at).toISOString(),
        })),
        hint:
          brands.length === 0
            ? 'No brands tracked yet — call track_brand to add one.'
            : undefined,
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    'list_prompts',
    {
      title: 'List active prompts',
      description:
        "List a brand's active buyer-intent prompts without changing them. Example: brand_id='acme' before an audit or refresh.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Brand ID whose active prompts to list.'),
      },
      outputSchema: listPromptsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ brand_id }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const prompts = await deps.db.getActivePrompts(brand_id);
      const payload = {
        brand_id,
        prompts: prompts.map((prompt) => ({
          id: prompt.id,
          text: prompt.text,
          intent_stage: prompt.intent_stage,
          shape: prompt.shape,
          created_at: new Date(prompt.created_at).toISOString(),
        })),
        count: prompts.length,
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    'set_prompts',
    {
      title: 'Set active prompts',
      description:
        "Replace a brand's active prompts with an exact supplied set; history is preserved. Example: brand_id='acme', prompts=['What is the best X for Y?'].",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to update.'),
        prompts: z
          .array(z.string().min(1).max(500))
          .min(1)
          .max(50)
          .describe('Exact 1-50 prompt set for future scans.'),
      },
      outputSchema: setPromptsOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ brand_id, prompts }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const result = await applyExactPromptSet(deps.db, brand_id, prompts);

      const payload = {
        brand_id,
        ...result,
        next_steps: `Call refresh_brand with brand_id '${brand_id}' to scan this prompt set.`,
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    'generate_prompts',
    {
      title: 'Generate brand prompts',
      description:
        "Replace active prompts with Claude-Haiku-generated buyer-intent prompts; requires ANTHROPIC_API_KEY and preserves history. Example: brand_id='acme', count=20.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to update.'),
        count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Buyer-intent prompts to generate.'),
      },
      outputSchema: generatePromptsOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ brand_id, count }) => {
      if (!deps.env.ANTHROPIC_API_KEY) {
        throw new Error(
          'ANTHROPIC_API_KEY not set — prompt generation requires Claude Haiku. Add the key to your MCP client config and restart the server.',
        );
      }
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const generated = await generatePrompts(
        { db: deps.db, ANTHROPIC_API_KEY: deps.env.ANTHROPIC_API_KEY },
        brand,
        count,
      );
      const payload = {
        brand_id,
        prompts_inserted: generated.length,
        prompt_source: 'generated' as const,
        prompts: generated.map((p) => p.text),
        next_steps: `Call refresh_brand with brand_id '${brand_id}' to scan the new prompt set.`,
      };
      return toolResult(payload);
    },
  );
}

function bucketStart(ts: number, granularity: 'daily' | 'weekly'): string {
  const d = new Date(ts);
  if (granularity === 'daily') {
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  }
  const day = d.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysFromMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

function citationId(runId: string, promptId: string): string {
  return `cit_${runId.slice(0, 8)}_${promptId.slice(0, 8)}`;
}

function buildTopSources(responses: PromptResponse[], brand: Brand) {
  const sources = new Map<
    string,
    {
      citation_count: number;
      prompts: Set<string>;
      engines: Set<string>;
      sample_url: string;
    }
  >();

  for (const response of responses) {
    const domainsForResponse = new Map<string, string>();
    for (const rawUrl of response.engine_citations) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
        if (parsed.username || parsed.password) continue;
        let domain = parsed.hostname.toLowerCase();
        if (domain.startsWith('www.')) domain = domain.slice(4);
        if (!domain) continue;
        if (!domainsForResponse.has(domain)) domainsForResponse.set(domain, rawUrl);
      } catch {
        // Provider-native citation payloads are external data. Ignore malformed
        // entries rather than letting one bad source hide the usable evidence.
      }
    }

    for (const [domain, sampleUrl] of domainsForResponse) {
      const existing = sources.get(domain);
      if (existing) {
        existing.citation_count += 1;
        existing.prompts.add(response.prompt_id);
        existing.engines.add(response.engine);
      } else {
        sources.set(domain, {
          citation_count: 1,
          prompts: new Set([response.prompt_id]),
          engines: new Set([response.engine]),
          sample_url: sampleUrl,
        });
      }
    }
  }

  return [...sources.entries()]
    .map(([domain, source]) => ({
      domain,
      citation_count: source.citation_count,
      prompt_count: source.prompts.size,
      engines: [...source.engines].sort(),
      sample_url: source.sample_url,
      is_brand_domain: hostMatchesDomain(domain, brand.domain),
    }))
    .sort(
      (a, b) =>
        b.citation_count - a.citation_count ||
        b.prompt_count - a.prompt_count ||
        a.domain.localeCompare(b.domain),
    )
    .slice(0, 10);
}

export function buildResponseExcerpt(text: string, brand: Brand): string {
  if (!text) return '';
  if (text === '[NO_AI_OVERVIEW]') return text;
  // Provider text is untrusted. Even a URL rejected as citation evidence can
  // otherwise expose authority credentials in the user-facing excerpt.
  const safeText = text.replace(/https?:\/\/[^\s<>"'`\])}]+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl.replace(/[.,;!]+$/, ''));
      return parsed.username || parsed.password ? '[credential-bearing URL omitted]' : rawUrl;
    } catch {
      return rawUrl;
    }
  });
  const idx = findTermSetMatchIndex(safeText, {
    domain: brand.domain,
    name: brand.name,
    aliases: brand.aliases,
    excludeTerms: brand.exclude_terms,
  });
  if (idx === -1) return safeText.slice(0, 250);
  const start = Math.max(0, idx - 100);
  const end = Math.min(safeText.length, idx + 150);
  return safeText.slice(start, end);
}

function pickBrandUrl(
  brand: Brand,
  engineCitations: string[],
  rawResponse: string,
): { url: string; source: 'provider_source' | 'answer_text' } | null {
  // Prefer original provider-listed URLs; answer-authored links are a distinct
  // evidence class and should not silently masquerade as native sources.
  for (const [urls, source] of [
    [engineCitations, 'provider_source'],
    [extractUrls(rawResponse), 'answer_text'],
  ] as const) {
    for (const rawUrl of urls) {
      const url = source === 'answer_text' ? rawUrl.replace(/[.,;!]+$/, '') : rawUrl;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
        if (parsed.username || parsed.password) continue;
        let host = parsed.hostname.toLowerCase();
        if (host.startsWith('www.')) host = host.slice(4);
        if (hostMatchesDomain(host, brand.domain)) return { url, source };
      } catch {
        // A malformed source cannot establish an actionable citation URL.
      }
    }
  }
  // Cited hosts are lossy evidence: do not fabricate a homepage URL from one.
  return null;
}
