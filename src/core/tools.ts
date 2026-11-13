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
import type { Brand, CitationSourceRow, ComparisonEvidenceRow, Db, Prompt, PromptResponse } from '../db/types.js';
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
  normalizeDomainInput,
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
  currently_tracked_competitors: z.array(z.string()),
  not_currently_tracked_competitors: z.array(z.string()),
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
  unmeasured_engines: z.array(z.string()),
  unmeasured_engines_note: z.string(),
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
    cadence_overdue_warning: z.boolean(),
    cadence_overdue_engines: z.array(z.string()),
    cadence_note: z.string(),
  }),
  prompt_set_comparability: z.object({
    active_prompt_count: z.number(),
    engines_with_retired_prompt_evidence: z.array(z.string()),
    historical_prompt_warning: z.boolean(),
    note: z.string(),
  }),
  prompt_set_scope: z.object({
    selection: z.enum(['full_window', 'active_only']),
    active_prompt_count: z.number(),
    excluded_successful_responses: z.number(),
    note: z.string(),
  }),
  configuration_comparability: z.object({
    brand_updated_at: z.string(),
    engines_scanned_before_update: z.array(z.string()),
    historical_settings_warning: z.boolean(),
    note: z.string(),
  }),
  identity_attribution: z.object({
    last_identity_change_at: z.string().nullable(),
    stale_engines: z.array(z.string()),
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
  losing_prompt_evidence_note: z.string(),
});

const historyModeCountsSchema = z.object({
  brand_mentions: z.number(),
  usable_prompts: z.number(),
  score: z.number(),
});
const historyModeScopeSchema = z.object({
  search_requested: historyModeCountsSchema.nullable(),
  model_only: historyModeCountsSchema.nullable(),
});

const historyOutputSchema = z.object({
  brand_id: z.string(),
  days: z.number(),
  granularity: z.enum(['daily', 'weekly']),
  engine_scope: z.object({
    selection: z.enum(['all_stored', 'selected']),
    requested_engines: z.array(z.string()),
    not_observed_engines: z.array(z.string()),
    note: z.string(),
  }),
  prompt_set_scope: z.object({
    selection: z.enum(['full_history', 'active_only']),
    active_prompt_count: z.number().int().nonnegative(),
    excluded_observations: z.number().int().nonnegative(),
    note: z.string(),
  }),
  identity_scope: z.object({
    selection: z.enum(['full_history', 'current_identity_only']),
    excluded_runs: z.number(),
    unknown_start_runs: z.number(),
    note: z.string(),
  }),
  google_search_sampling: googleSearchSamplingSchema,
  measurement_scope: z.object({
    measurement_mode_filter: z.enum(['model_only', 'search_requested']).nullable(),
    excluded_mode_runs: z.number().int().nonnegative(),
    mixed_mode_engines: z.array(z.string()),
    unmeasured_scoped_engines: z.array(z.string()),
    by_engine: z.record(z.string(), historyModeScopeSchema),
    by_bucket: z.record(z.string(), z.record(z.string(), historyModeScopeSchema)),
    note: z.string(),
  }),
  prompt_set_comparability: z.object({
    changes_detected: z.boolean(),
    changed_engines: z.array(z.string()),
    insufficient_evidence_engines: z.array(z.string()),
    current_active_roster: z.object({
      active_prompt_count: z.number(),
      latest_run_status_by_engine: z.record(z.string(), z.enum(['matches', 'differs', 'unverified'])),
      engines_needing_new_measurement: z.array(z.string()),
      note: z.string(),
    }),
    note: z.string(),
  }),
  identity_comparability: z.object({
    last_identity_change_at: z.string().nullable(),
    pre_change_runs: z.number(),
    post_change_runs: z.number(),
    mixes_identity_versions: z.boolean(),
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
  'prompts_won_against_you lists competitor mentions where the tracked brand is absent. ' +
  'Counts use the latest successful observation per run, engine and prompt so retries do not inflate shares.';

const COMPARISON_HISTORY_CAVEAT =
  'Competitor mentions were captured using the competitor list configured at scan time. ' +
  'Changing that list does not re-evaluate historical responses; a zero for a newly added ' +
  'competitor may mean it was not tracked, not that it was absent from AI answers. ' +
  'The current configuration cannot prove which competitors were tracked in past scans.';

const compareOutputSchema = z.object({
  brand_id: z.string(),
  days: z.number(),
  identity_attribution: z.object({
    last_identity_change_at: z.string().nullable(),
    excluded_responses: z.number().int().nonnegative(),
    note: z.string(),
  }),
  observation_coverage: z.object({
    status: z.enum(['not_compared', 'no_observations', 'observed']),
    successful_responses: z.number().int().nonnegative(),
    per_engine: z.array(z.object({
      engine: z.string(),
      successful_responses: z.number().int().nonnegative(),
      distinct_runs: z.number().int().nonnegative(),
      distinct_prompts: z.number().int().nonnegative(),
      last_observed_at: z.string(),
    })),
    note: z.string(),
  }),
  google_search_sampling: googleSearchSamplingSchema,
  comparison_semantics: z.string(),
  historical_coverage_note: z.string(),
  outside_current_tracking: z.array(z.string()),
  prompt_set_scope: z.object({
    selection: z.enum(['full_window', 'active_only']),
    active_prompt_count: z.number().int().nonnegative().nullable(),
    excluded_observations: z.number().int().nonnegative(),
    note: z.string(),
  }),
  engine_scope: z.object({
    selection: z.enum(['all_stored', 'selected']),
    requested_engines: z.array(z.string()),
    not_observed_engines: z.array(z.string()),
    unmeasured_scoped_engines: z.array(z.string()),
    note: z.string(),
  }),
  measurement_scope: z.object({
    measurement_mode_filter: z.enum(['model_only', 'search_requested']).nullable(),
    excluded_mode_responses: z.number().int().nonnegative(),
    note: z.string(),
  }),
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
  measurement_mode_filter: z.enum(['model_only', 'search_requested']).nullable(),
  engine_scope: z.object({
    selection: z.enum(['selected', 'all_stored']),
    requested_engines: z.array(z.string()),
    not_observed_engines: z.array(z.string()),
    note: z.string(),
  }),
  google_search_sampling: googleSearchSamplingSchema,
  identity_attribution: z.object({
    identity_changed_at: z.string(),
    note: z.string(),
  }).nullable(),
  identity_filter: z.object({
    selection: z.enum(['full_history', 'current_identity_only']),
    applied: z.boolean(),
    note: z.string(),
  }),
  prompt_set_scope: z.object({
    selection: z.enum(['full_history', 'active_only']),
    active_prompt_count: z.number().int().nonnegative().nullable(),
    note: z.string(),
  }),
  limit: z.number().int(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  top_sources: z.array(
    z.object({
      domain: z.string(),
      citation_count: z.number(),
      prompt_count: z.number(),
      engines: z.array(z.string()),
      measurement_modes: z.array(z.enum(['model_only', 'search_requested'])),
      sample_url: z.string(),
      is_brand_domain: z.boolean(),
      identity_scopes: z.array(z.enum(['current', 'historical', 'unattributed'])).optional(),
    }),
  ),
  citations: z.array(
    z.object({
      id: z.string(),
      engine: z.string(),
      prompt: z.string(),
      cited_at: z.string(),
      citation_type: z.string(),
      measurement_mode: z.enum(['model_only', 'search_requested']),
      identity_scope: z.enum(['current', 'historical', 'unattributed']).optional(),
      response_excerpt: z.string(),
      cited_url: z.string().nullable(),
      url_source: z.enum(['provider_source', 'answer_text']).nullable(),
    }),
  ),
});

const citationCursorSchema = z.object({
  v: z.literal(1),
  brand_id: z.string(),
  days: z.number().min(1).max(90),
  engine: z.string().nullable(),
  engines: z.array(engineSchema).optional(),
  measurement_mode: z.enum(['model_only', 'search_requested']).optional(),
  identity_selection: z.enum(['full_history', 'current_identity_only']).optional(),
  identity_boundary: z.number().int().nullable().optional(),
  prompt_selection: z.enum(['full_history', 'active_only']).optional(),
  prompt_roster_digest: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  since: z.number().finite(),
  until: z.number().int(),
  before: z.object({
    captured_at: z.number().int(),
    run_id: z.string(),
    prompt_id: z.string(),
    response_id: z.string().min(1).max(128).optional(),
  }),
});

const CITATION_CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CITATION_DAY_MS = 86_400_000;

async function citationPromptRosterDigest(prompts: Prompt[]): Promise<string> {
  const canonicalIds = prompts.map(({ id }) => id).sort().join('\u001f');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalIds));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeCitationCursor(
  cursor: string, brandId: string, days: number, engine: string | null,
  engines: string[],
  measurementMode: 'model_only' | 'search_requested' | undefined,
  currentIdentityOnly: boolean, identityBoundary: number | null,
  activePromptsOnly: boolean, promptRosterDigest: string | null,
) {
  try {
    const parsed = citationCursorSchema.parse(JSON.parse(decodeURIComponent(cursor)));
    const now = Date.now();
    // Cursor parameters are client-controlled, not authenticated. Never allow
    // one to expand a requested 1-90-day citation query into an unbounded scan
    // or to select an arbitrary older historical window.
    if (parsed.brand_id !== brandId || parsed.days !== days || parsed.engine !== engine ||
      JSON.stringify(parsed.engines ?? []) !== JSON.stringify(engines) ||
      (parsed.measurement_mode ?? null) !== (measurementMode ?? null) ||
      (parsed.identity_selection ?? 'full_history') !==
        (currentIdentityOnly ? 'current_identity_only' : 'full_history') ||
      (currentIdentityOnly && parsed.identity_boundary !== identityBoundary) ||
      (parsed.prompt_selection ?? 'full_history') !==
        (activePromptsOnly ? 'active_only' : 'full_history') ||
      (activePromptsOnly && parsed.prompt_roster_digest !== promptRosterDigest) ||
      !Number.isFinite(parsed.since) || !Number.isSafeInteger(parsed.until) ||
      !Number.isSafeInteger(parsed.before.captured_at) ||
      parsed.until > now || parsed.until < now - CITATION_CURSOR_MAX_AGE_MS ||
      parsed.since !== parsed.until - days * CITATION_DAY_MS ||
      parsed.before.captured_at < parsed.since ||
      parsed.before.captured_at > parsed.until) {
      throw new Error('Mismatched cursor scope');
    }
    return parsed;
  } catch {
    throw new Error('Invalid citation cursor. Start again without cursor or preserve the brand, days, engine/engines, measurement mode, identity and prompt selection.');
  }
}

const contentGapsOutputSchema = z.object({
  brand_id: z.string(),
  engine_scope: z.object({
    selection: z.enum(['selected', 'all_stored']),
    requested_engines: z.array(z.string()),
    not_observed_engines: z.array(z.string()),
    unmeasured_scoped_engines: z.array(z.string()),
    note: z.string(),
  }),
  google_search_sampling: googleSearchSamplingSchema,
  identity_attribution: z.object({
    last_identity_change_at: z.string().nullable(),
    stale_engines: z.array(z.string()),
    note: z.string(),
  }),
  observation_coverage: z.object({
    active_prompt_count: z.number().int().nonnegative(),
    per_engine: z.array(z.object({
      engine: z.string(),
      run_id: z.string(),
      refreshed_at: z.string().nullable(),
      usable_prompt_count: z.number().int().nonnegative(),
      missing_prompt_count: z.number().int().nonnegative(),
    })),
    incomplete_engines: z.array(z.string()),
    unmeasured_engines: z.array(z.string()),
    note: z.string(),
  }),
  losing_prompt_evidence: z.object({
    note: z.string(),
    prompts: z.array(z.object({
      prompt_id: z.string(),
      prompt_text: z.string(),
      observations: z.array(z.object({
        engine: z.string(),
        run_id: z.string(),
        response_id: z.string(),
        captured_at_ms: z.number(),
        competitors_mentioned: z.array(z.string()),
      })),
    })),
  }),
  configuration_comparability: z.object({
    brand_updated_at: z.string().nullable(),
    engines_scanned_before_update: z.array(z.string()),
    historical_settings_warning: z.boolean(),
    note: z.string(),
  }),
  measurement_scope: z.object({
    search_requested_engines: z.array(z.string()),
    model_only_engines: z.array(z.string()),
    mixed_modes: z.boolean(),
    note: z.string(),
  }),
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
  prompt_review: z.object({
    category_missing: z.boolean(),
    prompts_naming_brand: z.number().int(),
    review_recommended: z.boolean(),
    note: z.string(),
  }),
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
  if (requested === undefined) return [...available];
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
        "Read stored scores. active_prompts_only=true measures current buyer questions; default includes history. run_mode filters stored live/batch scans. Live need not cite sources. Example: brand_id='acme'.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to inspect.'),
        engines: z
          .array(engineSchema)
          .optional()
          .describe('Engines to include; omit or pass [] for all stored engines.'),
        run_mode: z
          .enum(['live', 'batch'])
          .optional()
          .describe('Filter by live or batch scans; omit for latest across modes. Live may still be model-only.'),
        active_prompts_only: z.boolean().default(false)
          .describe('Score only currently active buyer prompts from stored observations; no provider calls.'),
      },
      outputSchema: visibilityOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, engines, run_mode, active_prompts_only = false }) => {
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
      const identityChangedAt = brand.identity_changed_at ?? null;
      const staleIdentityEngines: string[] = [];
      const measurementModeByEngine = new Map<string, 'search_requested' | 'model_only'>();
      let mostRecentTimestamp = 0;
      for (const engine of selectedEngines) {
        const run = await deps.db.getLatestCompletedRun(brand_id, engine, run_mode);
        if (!run) continue;
        const responses = await deps.db.getResponsesForRun(run.id);
        if (responses.length === 0) continue;
        // Stored mention flags were scored against the brand identity at scan
        // time. Do not attribute them to a later name/domain/alias revision.
        if (identityChangedAt !== null && run.started_at < identityChangedAt) {
          staleIdentityEngines.push(engine);
          continue;
        }
        selectedResponses.push(...responses);
        observedPromptIdsByEngine.set(engine, new Set(
          responses.filter((response) => response.status === 'ok').map((response) => response.prompt_id),
        ));
        measurementModeByEngine.set(engine, visibilityMeasurementMode(engine, run.mode));
        expectedPromptsByEngine.set(engine, run.prompts_total);
        const ts = run.completed_at ?? run.started_at;
        refreshedAtByEngine.set(engine, new Date(ts).toISOString());
        refreshMsByEngine.set(engine, ts);
        startedMsByEngine.set(engine, run.started_at);
        if (ts > mostRecentTimestamp) mostRecentTimestamp = ts;
      }
      if (selectedResponses.length === 0) {
        if (staleIdentityEngines.length > 0) {
          throw new Error('No current-identity visibility data for the selected engines. Stored scans predate the last brand name, domain, alias, or exclusion change; call refresh_brand to measure the current identity (provider charges may apply). Historical runs remain available in get_visibility_history.');
        }
        throw new Error(
          engines && engines.length > 0
            ? 'No visibility data yet for the selected engines. Call refresh_brand to populate them.'
            : 'No visibility data yet for this brand. Call refresh_brand to populate it.',
        );
      }
      const activePrompts = await deps.db.getActivePrompts(brand_id);
      const activePromptIds = new Set(activePrompts.map((prompt) => prompt.id));
      const scoredResponses = active_prompts_only
        ? selectedResponses.filter((row) => activePromptIds.has(row.prompt_id))
        : selectedResponses;
      const scored = computeOverallScore(brand, scoredResponses);
      // A snapshot containing only retired questions is not a measured zero.
      if (active_prompts_only && scored.per_engine.length === 0) {
        throw new Error('No successful stored observations for currently active buyer prompts in the selected engines. A new scan may incur provider charges; historical results remain available without active_prompts_only.');
      }
      const scoredEngines = new Set(scored.per_engine.map(({ engine }) => engine));
      // An explicit multi-engine request must disclose engines whose latest
      // run contains no successful currently active questions.
      const unmeasuredEngines = selectedEngines.filter((engine) =>
        active_prompts_only ? !scoredEngines.has(engine) : !refreshedAtByEngine.has(engine));
      const missingRequestedEngines = engines && engines.length > 0
        ? unmeasuredEngines
        : [];
      const scoredRefreshMs = [...refreshMsByEngine.entries()]
        .filter(([engine]) => !active_prompts_only || scoredEngines.has(engine));
      const oldestTimestamp = Math.min(...scoredRefreshMs.map(([, timestamp]) => timestamp));
      mostRecentTimestamp = Math.max(...scoredRefreshMs.map(([, timestamp]) => timestamp));
      const ageSpreadMs = mostRecentTimestamp - oldestTimestamp;
      // Warn only for materially different observation windows, not minor
      // dispatch delays within a normal multi-engine refresh.
      const mixedAgeCutoffMs = 24 * 60 * 60 * 1000;
      const olderEngines = scoredRefreshMs
        .filter(([, timestamp]) => mostRecentTimestamp - timestamp >= mixedAgeCutoffMs)
        .map(([engine]) => engine)
        .sort();
      // Relative scan age misses uniformly old snapshots. Flag absolute age
      // against configured cadence without implying that cron or billing failed.
      const cadenceMs = brand.refresh_frequency === 'daily'
        ? 24 * 60 * 60 * 1000
        : brand.refresh_frequency === 'weekly'
          ? 7 * 24 * 60 * 60 * 1000
          : null;
      const cadenceOverdueEngines = cadenceMs === null ? [] : scoredRefreshMs
        .filter(([, timestamp]) => Date.now() - timestamp > cadenceMs)
        .map(([engine]) => engine)
        .sort();
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
        .filter(([engine]) => !active_prompts_only || scoredEngines.has(engine))
        .filter(([, startedAt]) => startedAt < brand.updated_at)
        .map(([engine]) => engine)
        .sort();
      const perEngine = scored.per_engine.map((engine) => {
        // The score is conditional on distinct usable prompt observations.
        // Report sample coverage explicitly rather than treating retries as
        // extra prompts or presenting a partial scan as full.
        const expected = active_prompts_only ? Math.max(engine.total_prompts, activePromptIds.size)
          : Math.max(engine.total_prompts, expectedPromptsByEngine.get(engine.engine) ?? 0);
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
        unmeasured_engines: unmeasuredEngines,
        unmeasured_engines_note: active_prompts_only
          ? 'These engines have no successful stored observations for the currently active buyer prompts in the selected run mode and are excluded from overall_score. They are unmeasured, not observed zeros. A new scan may incur provider charges.'
          : 'These known or requested engines have no usable current-identity stored observations for the selected run mode and are excluded from overall_score. Stale identity engines listed in identity_attribution were deliberately excluded; for other absent engines, absence does not establish whether an engine was configured, attempted or failed.',
        measurement_scope: {
          search_requested: searchRequested,
          model_only: modelOnly,
          mixed_modes: searchRequested.engines.length > 0 && modelOnly.engines.length > 0,
          note: 'Scores count brand mentions in the latest usable observation per distinct prompt and engine, not independently verified search citations. Search-requested engines use a live search/SERP request path but may return no source links. Claude and Gemini here use model-only answers; ungrounded batch runs are also model-only. Compare these groups separately, especially before interpreting the combined overall_score.',
        },
        google_search_sampling: googleSearchSampling(perEngine.map(({ engine }) => engine)),
        freshness: {
          oldest_refreshed_at: new Date(oldestTimestamp).toISOString(),
          newest_refreshed_at: new Date(mostRecentTimestamp).toISOString(),
          age_spread_hours: Math.round((ageSpreadMs / 3600000) * 10) / 10,
          mixed_age_warning: olderEngines.length > 0,
          older_engines: olderEngines,
          cadence_overdue_warning: cadenceOverdueEngines.length > 0,
          cadence_overdue_engines: cadenceOverdueEngines,
          cadence_note: cadenceMs === null
            ? 'Manual refresh has no scheduled cadence; stored observation age is not classified as overdue.'
            : 'Overdue means the selected stored observation age exceeds the daily or weekly brand cadence, not that cron failed or prompt coverage was complete.',
        },
        prompt_set_comparability: {
          active_prompt_count: activePromptIds.size,
          engines_with_retired_prompt_evidence: retiredPromptEngines,
          historical_prompt_warning: retiredPromptEngines.length > 0,
          note: active_prompts_only
            ? 'Retired prompts from the stored snapshots were excluded from the displayed scores and rankings. Listed engines still have retired evidence in history; missing active prompts are unmeasured, not observed zeros.'
            : retiredPromptEngines.length > 0
            ? 'Latest scored responses from the listed engines include prompts no longer in the active set. Their scores remain historical observations and should not be compared as measurements of the current prompt set. Partial scan coverage is reported separately.'
            : 'No retired prompt IDs were observed in these scored responses. This does not prove complete coverage of the current prompt set; inspect per-engine coverage separately.',
        },
        prompt_set_scope: {
          selection: active_prompts_only ? 'active_only' as const : 'full_window' as const,
          active_prompt_count: activePromptIds.size,
          excluded_successful_responses: active_prompts_only
            ? selectedResponses.filter((row) => row.status === 'ok' && !activePromptIds.has(row.prompt_id)).length
            : 0,
          note: active_prompts_only
            ? 'Scores and winning/losing prompts use only successful stored observations for active buyer-prompt IDs, with duplicate attempts deduplicated for scoring. Excluded count describes stored successful rows, not unique prompts. An active prompt missing from a scan is unmeasured, not a score of zero; no provider calls are made.'
            : 'Full historical snapshot scores may include retired buyer prompts. Set active_prompts_only=true for currently active questions without rerunning any provider.',
        },
        configuration_comparability: {
          brand_updated_at: new Date(brand.updated_at).toISOString(),
          engines_scanned_before_update: enginesBeforeBrandUpdate,
          historical_settings_warning: enginesBeforeBrandUpdate.length > 0,
          note: 'Brand settings were updated after the listed engines began their latest scans. Stored responses retain their original scoring and may reflect earlier brand identity, aliases, exclusions, or competitor tracking; the database cannot establish which settings changed. A cadence-only update may not affect the evidence. Review changes and refresh affected engines before relying on current-configuration comparisons.',
        },
        identity_attribution: {
          last_identity_change_at: identityChangedAt === null
            ? null : new Date(identityChangedAt).toISOString(),
          stale_engines: staleIdentityEngines.sort(),
          note: 'Runs started before the last matching-identity change are excluded from current scores and listed as stale engines, not treated as observed zeros. Refresh those engines before measuring the current brand identity (provider charges may apply). Historical runs remain available in history; older changes before identity-boundary migration are unknown.',
        },
        per_engine: perEngine,
        top_winning_prompts: scored.top_winning_prompts,
        winning_prompt_evidence_note: 'engines_cited_in is a legacy field counting brand mentions in answers, not source citations. Use engines_mentioned_in for mention evidence and engines_with_brand_link for linked brand evidence. A link-only source without an answer mention is not a winning prompt.',
        top_losing_prompts: scored.top_losing_prompts,
        losing_prompt_evidence_note: 'competitors_cited retains historical answer mentions, not verified source links. The tracked and not-currently-tracked lists describe the present competitor roster, not the roster at observation time; historical scores and observations are not rewritten. Refresh scans before interpreting current competitors.',
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    toolName('get_visibility_history'),
    {
      title: 'Get AI visibility history',
      description:
        "Stored trends. Optional engines and measurement_mode select AI surfaces and request mode; missing evidence is unmeasured. Identity/prompt filters apply to stored data. Defaults retain history. Example: brand_id='acme', days=30.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to inspect.'),
        engines: z.array(engineSchema).optional()
          .describe('Only include these engines in trends and metadata; omit or pass [] for all stored engines.'),
        measurement_mode: z.enum(['model_only', 'search_requested']).optional()
          .describe('Filter by request mode; omit for combined history. Search-requested does not prove citations.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(30)
          .describe('Previous calendar days to include.'),
        granularity: z
          .enum(['daily', 'weekly'])
          .default('weekly')
          .describe('Time bucket for the series.'),
        current_identity_only: z.boolean().default(false)
          .describe('Exclude runs not attributable to the current brand identity; no provider calls.'),
        active_prompts_only: z.boolean().default(false)
          .describe('Score only currently active buyer prompts using stored responses; no provider calls.'),
      },
      outputSchema: historyOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, engines, measurement_mode, days, granularity, current_identity_only = false, active_prompts_only = false }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      // History is bucketed by UTC calendar day/week. A rolling 24-hour
      // cutoff would omit early scans from the first requested day and can
      // return one more daily bucket than the requested day count.
      const now = new Date(Date.now());
      const since = Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1,
      );
      const storedResults = await deps.db.getVisibilityHistoryRows(brand_id, since);
      const requestedEngines = engines && engines.length > 0 ? uniqueEngineNames(engines) : null;
      const selectedSet = requestedEngines ? new Set<string>(requestedEngines) : null;
      // Scope before calculating any score, cohort, provenance or missing-evidence
      // metadata. Filtering the finished series would leave misleading totals.
      const engineScopedResults = selectedSet
        ? storedResults.filter((row) => selectedSet.has(row.engine))
        : storedResults;
      // Compare modes at the run level before trend buckets, provenance and
      // current-roster analysis, never by filtering already-computed scores.
      const allResults = measurement_mode
        ? engineScopedResults.filter((row) =>
          visibilityMeasurementMode(row.engine, row.mode ?? 'live') === measurement_mode)
        : engineScopedResults;
      const excludedModeRuns = engineScopedResults.length - allResults.length;
      const observedEngines = new Set(engineScopedResults.map((row) => row.engine));
      const engine_scope = {
        selection: requestedEngines ? 'selected' as const : 'all_stored' as const,
        requested_engines: requestedEngines ?? [],
        not_observed_engines: requestedEngines?.filter((engine) => !observedEngines.has(engine)) ?? [],
        note: requestedEngines
          ? 'Only requested AI surfaces contribute to the selected history and metadata. A requested engine with no stored observations in this window is unmeasured, not a zero score; this does not prove it was configured or scanned and makes no provider requests.'
          : 'History includes all engines with stored observations in this window. Omit engines or pass [] to preserve this default; no provider requests are made.',
      };
      const identityChangedAt = brand.identity_changed_at ?? null;
      // A run completed after an identity edit may have started before it.
      // Missing run-start provenance cannot establish current identity.
      const scopedResults = current_identity_only && identityChangedAt !== null
        ? allResults.filter((row) =>
          typeof row.started_at === 'number' && Number.isFinite(row.started_at) &&
          row.started_at >= identityChangedAt,
        )
        : allResults;
      const activePromptIds = (await deps.db.getActivePrompts(brand_id)).map((prompt) => prompt.id);
      // Preserve original run rosters for comparability even if a run has no
      // currently active questions and therefore contributes no trend score.
      const results = active_prompts_only
        ? scopedResults.filter((row) => Number(row.active_total ?? 0) > 0)
          .map((row) => ({ ...row, total: row.active_total ?? 0, hits: row.active_hits ?? 0 }))
        : scopedResults;
      const prompt_set_scope = {
        selection: active_prompts_only ? 'active_only' as const : 'full_history' as const,
        active_prompt_count: activePromptIds.length,
        excluded_observations: active_prompts_only
          ? scopedResults.reduce((sum, row) =>
            sum + Math.max(0, Number(row.total ?? 0) - Number(row.active_total ?? 0)), 0)
          : 0,
        note: active_prompts_only
          ? 'Trends and evidence counts use only stored successful observations of currently active buyer questions. Retired-only runs are unmeasured, not zeros. This does not perform a new scan or establish that the full current roster was measured.'
          : 'Historical scores retain all recorded buyer questions, including retired ones. Set active_prompts_only=true for current-question trends using stored responses without provider calls.',
      };
      const unknownStartRuns = allResults.filter((row) =>
        typeof row.started_at !== 'number' || !Number.isFinite(row.started_at),
      ).length;
      const identity_scope = {
        selection: current_identity_only ? 'current_identity_only' as const : 'full_history' as const,
        excluded_runs: allResults.length - scopedResults.length,
        unknown_start_runs: unknownStartRuns,
        note: identityChangedAt === null
          ? 'No recorded matching-identity boundary exists. All stored history is retained; older identity edits before tracking began cannot be reconstructed.'
          : current_identity_only
            ? 'Only runs with a known start at or after the latest matching-identity change contribute to the displayed trend and evidence counts. Earlier or unattributable runs are excluded, not measured zeros. Provider requests are not made.'
            : 'Full historical series includes earlier matching identities and runs with unknown start provenance. Set current_identity_only=true to compare only observations attributable to the current identity.',
      };
      const preChangeRuns = identityChangedAt === null ? 0
        : allResults.filter((row) =>
          typeof row.started_at === 'number' && Number.isFinite(row.started_at) &&
          row.started_at < identityChangedAt,
        ).length;
      const postChangeRuns = identityChangedAt === null ? 0
        : allResults.filter((row) =>
          typeof row.started_at === 'number' && Number.isFinite(row.started_at) &&
          row.started_at >= identityChangedAt,
        ).length;
      const identity_comparability = {
        last_identity_change_at: identityChangedAt === null
          ? null : new Date(identityChangedAt).toISOString(),
        pre_change_runs: preChangeRuns,
        post_change_runs: postChangeRuns,
        mixes_identity_versions: preChangeRuns > 0 && postChangeRuns > 0,
        note: 'Stored runs started before the latest brand matching-identity edit may not be comparable with later runs, even when a scan completed after the edit. Historical scores are retained, not re-scored against the current name/domain/aliases/exclusions. Only known run start times count toward pre/post groups; missing start provenance is unattributed. Older edits before this migration cannot be reconstructed.',
      };

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
      // A filtered series can omit engines that have stored history but no
      // evidence for the selected identity/prompt cohort. Expose those gaps
      // without implying that never-scanned or unconfigured engines were used.
      const measuredScopedEngines = new Set(results.map((row) => row.engine));
      const unmeasuredScopedEngines = [...new Set(engineScopedResults.map((row) => row.engine))]
        .filter((engine) => !measuredScopedEngines.has(engine)).sort();
      const measurement_scope = {
        measurement_mode_filter: measurement_mode ?? null,
        excluded_mode_runs: excludedModeRuns,
        mixed_mode_engines: [...scopeCounts.entries()]
          .filter(([, counts]) =>
            counts.search_requested.usable_prompts > 0 && counts.model_only.usable_prompts > 0,
          )
          .map(([engine]) => engine).sort(),
        unmeasured_scoped_engines: unmeasuredScopedEngines,
        by_engine: Object.fromEntries([...scopeCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([engine, counts]) => [engine, {
            search_requested: scoredCounts(counts.search_requested),
            model_only: scoredCounts(counts.model_only),
          }])),
        note: 'Without a request-mode filter, combined legacy daily and weekly scores may mix model-only and search-requested runs. When measurement_mode_filter is set, trends, provenance, rosters and by_bucket use only that mode; excluded_mode_runs counts stored runs removed by this selection. by_engine and by_bucket disclose scored denominators. unmeasured_scoped_engines have stored history but no usable rows after the selected mode, identity and buyer-prompt filters; they are unmeasured, not observed zeros. Never-scanned engines are not inferred, no provider calls occur, and search-requested responses do not necessarily contain citations.',
      };

      // Only compare complete recorded run rosters. Comparing successful
      // responses alone would falsely flag a change after a partial scan.
      // Prompt IDs are stable while active and change on set_prompts.
      const promptRosters = new Map<string, Set<string>>();
      const incompleteRosters = new Set<string>();
      const latestRosters = new Map<string, { completed_at: number; signature: string | null }>();
      for (const row of scopedResults) {
        const expected = row.roster_expected;
        const observed = row.roster_observed;
        const ids = row.roster_ids_csv?.split(',') ?? [];
        const complete = !(
          typeof expected !== 'number' || expected <= 0 ||
          observed !== expected || ids.length !== expected ||
          ids.some((id) => !id)
        );
        const signature = complete ? [...ids].sort().join('\u001f') : null;
        const previousLatest = latestRosters.get(row.engine);
        if (!previousLatest || row.completed_at > previousLatest.completed_at) {
          latestRosters.set(row.engine, { completed_at: row.completed_at, signature });
        } else if (row.completed_at === previousLatest.completed_at && signature !== previousLatest.signature) {
          // Equal timestamps cannot prove which prompt cohort was observed last.
          latestRosters.set(row.engine, { completed_at: row.completed_at, signature: null });
        }
        if (!complete) {
          incompleteRosters.add(row.engine);
          continue;
        }
        const signatures = promptRosters.get(row.engine) ?? new Set<string>();
        signatures.add(signature!);
        promptRosters.set(row.engine, signatures);
      }
      const changedEngines = [...promptRosters.entries()]
        .filter(([, signatures]) => signatures.size > 1)
        .map(([engine]) => engine).sort();
      const insufficientEngines = [...new Set(scopedResults.map((row) => row.engine))]
        .filter((engine) =>
          incompleteRosters.has(engine) || (promptRosters.get(engine)?.size ?? 0) < 1,
        ).sort();
      const activeRosterSignature = activePromptIds.length > 0
        ? [...activePromptIds].sort().join('\u001f') : null;
      const latest_run_status_by_engine = Object.fromEntries([...latestRosters.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([engine, latest]) => [engine,
          activeRosterSignature === null || latest.signature === null
            ? 'unverified'
            : latest.signature === activeRosterSignature ? 'matches' : 'differs',
        ]));
      const prompt_set_comparability = {
        changes_detected: changedEngines.length > 0,
        changed_engines: changedEngines,
        insufficient_evidence_engines: insufficientEngines,
        current_active_roster: {
          active_prompt_count: activePromptIds.length,
          latest_run_status_by_engine,
          engines_needing_new_measurement: Object.keys(latest_run_status_by_engine)
            .filter((engine) => latest_run_status_by_engine[engine] === 'differs'),
          note: 'Most recent completed run per engine is compared with the current active prompt IDs. A differing complete roster needs new measurement; a partial or missing roster is unverified, not proof of current coverage. Historical scores remain unchanged.',
        },
        note: 'Changes are detected only when complete recorded prompt-ID rosters differ for the same engine. Different prompt sets make historical scores non-comparable; partial or missing rosters cannot establish stability.',
      };

      const bucketModes = new Map<string, Map<string, {
        search_requested: Counts;
        model_only: Counts;
      }>>();
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
        const perEngineModes = bucketModes.get(date) ?? new Map();
        const modeCounts = perEngineModes.get(row.engine) ?? {
          search_requested: { brand_mentions: 0, usable_prompts: 0 },
          model_only: { brand_mentions: 0, usable_prompts: 0 },
        };
        const mode = visibilityMeasurementMode(row.engine, row.mode ?? 'live');
        modeCounts[mode].brand_mentions += hits;
        modeCounts[mode].usable_prompts += total;
        perEngineModes.set(row.engine, modeCounts);
        bucketModes.set(date, perEngineModes);
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

      const by_bucket = Object.fromEntries([...bucketModes.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, engines]) => [date, Object.fromEntries([...engines.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([engine, counts]) => [engine, {
            search_requested: scoredCounts(counts.search_requested),
            model_only: scoredCounts(counts.model_only),
          }]))]));

      const payload = {
        brand_id,
        days,
        granularity,
        engine_scope,
        prompt_set_scope,
        identity_scope,
        google_search_sampling: googleSearchSampling(results.map(({ engine }) => engine)),
        measurement_scope: { ...measurement_scope, by_bucket },
        prompt_set_comparability,
        identity_comparability,
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
        "Compare stored brand/competitor mentions and share of voice. Select engines, active buyer prompts or request mode for like-for-like evidence. No provider calls. Example: brand_id='acme'.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to compare.'),
        engines: z.array(engineSchema).optional()
          .describe('Only compare these engines; omit or pass [] for all stored engines.'),
        measurement_mode: z.enum(['model_only', 'search_requested']).optional()
          .describe('Compare only one stored request mode; omit to combine both modes.'),
        competitor_domains: z
          .array(z.string())
          .optional()
          .describe("Competitor domains; omit to use the brand's configured list."),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(7)
          .describe('Previous days to compare.'),
        active_prompts_only: z
          .boolean()
          .default(false)
          .describe('Exclude observations for retired prompts; default keeps the full historical comparison window.'),
      },
      outputSchema: compareOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, engines, measurement_mode, competitor_domains, days, active_prompts_only }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const requestedEngines = engines && engines.length > 0 ? uniqueEngineNames(engines) : null;
      const targets = competitor_domains === undefined
        ? brand.competitors
        : normalizeCompetitorDomains(competitor_domains, brand.domain);
      const outsideCurrentTracking = targets.filter(
        (domain) => !brand.competitors.includes(domain),
      );
      const identityChangedAt = brand.identity_changed_at ?? null;
      const lastIdentityChangeAt = identityChangedAt === null
        ? null : new Date(identityChangedAt).toISOString();
      if (targets.length === 0) {
        const payload = {
          brand_id,
          days,
          identity_attribution: {
            last_identity_change_at: lastIdentityChangeAt,
            excluded_responses: 0,
            note: 'No competitor response evidence was queried.',
          },
          observation_coverage: {
            status: 'not_compared' as const,
            successful_responses: 0,
            per_engine: [],
            note: 'No competitors are configured or selected; response evidence was not queried.',
          },
          google_search_sampling: null,
          message: competitor_domains === undefined
            ? 'No competitor list configured for this brand. Pass competitor_domains or set brand.competitors.'
            : 'No competitor domains selected. Pass one or more competitor_domains to compare.',
          your_share_of_voice_pct: 0,
          your_mentions: 0,
          comparison_semantics: COMPARISON_SEMANTICS,
          historical_coverage_note: COMPARISON_HISTORY_CAVEAT,
          outside_current_tracking: outsideCurrentTracking,
          prompt_set_scope: {
            selection: active_prompts_only ? 'active_only' as const : 'full_window' as const,
            active_prompt_count: null,
            excluded_observations: 0,
            note: 'No comparison targets were selected, so no prompt or response evidence was queried.',
          },
          engine_scope: {
            selection: requestedEngines ? 'selected' as const : 'all_stored' as const,
            requested_engines: requestedEngines ?? [],
            not_observed_engines: [],
            unmeasured_scoped_engines: [],
            note: 'No comparison targets were selected. No engine evidence was queried, so missing observations cannot be classified.',
          },
          measurement_scope: {
            measurement_mode_filter: measurement_mode ?? null,
            excluded_mode_responses: 0,
            note: 'No comparison targets were selected; no stored request-mode evidence was queried.',
          },
          competitors: [],
          prompts_you_win: [],
          prompts_brand_only: [],
          prompts_co_mentioned: [],
          requested_competitor_domains: competitor_domains ?? null,
        };
        return toolResult(payload);
      }

      const since = Date.now() - days * 86_400_000;
      const fetchedResponses = await deps.db.getResponsesSince(brand_id, since);
      const selectedEngineSet = requestedEngines ? new Set<string>(requestedEngines) : null;
      // Apply the engine scope before deduplication and every downstream
      // attribution, prompt ranking, share and measurement calculation.
      const selectedResponses = selectedEngineSet
        ? fetchedResponses.filter((row) => selectedEngineSet.has(row.engine))
        : fetchedResponses;
      const modeResponses = measurement_mode
        ? selectedResponses.filter((row) =>
          visibilityMeasurementMode(row.engine, row.mode ?? 'live') === measurement_mode)
        : selectedResponses;
      const excludedModeResponses = selectedResponses.length - modeResponses.length;
      const preModeSuccessfulEngines = new Set(selectedResponses
        .filter((row) => row.status === 'ok').map((row) => row.engine));
      // Preserve every distinct scan in the selected window, but do not
      // count repeated successful attempts for the same scan/prompt twice.
      const latestByRunPrompt = new Map<string, ComparisonEvidenceRow>();
      for (const row of modeResponses) {
        if (row.status !== 'ok') continue;
        const key = JSON.stringify([row.run_id, row.engine, row.prompt_id]);
        const previous = latestByRunPrompt.get(key);
        if (!previous || row.captured_at > previous.captured_at ||
            (row.captured_at === previous.captured_at && row.id > previous.id)) {
          latestByRunPrompt.set(key, row);
        }
      }
      const deduplicated = [...latestByRunPrompt.values()];
      // A response can arrive after the matching identity changed while its
      // run was started against the old brand configuration.
      const currentIdentityResponses = identityChangedAt === null ? deduplicated
        : deduplicated.filter((row) =>
          typeof row.run_started_at === 'number' &&
          Number.isFinite(row.run_started_at) && row.run_started_at >= identityChangedAt);
      const excludedResponses = deduplicated.length - currentIdentityResponses.length;
      const activePromptIds = active_prompts_only
        ? new Set((await deps.db.getActivePrompts(brand_id)).map((prompt) => prompt.id))
        : null;
      const allResponses = activePromptIds === null ? currentIdentityResponses
        : currentIdentityResponses.filter((row) => activePromptIds.has(row.prompt_id));
      const usableEngines = new Set(allResponses.map((row) => row.engine));
      const engine_scope = {
        selection: requestedEngines ? 'selected' as const : 'all_stored' as const,
        requested_engines: requestedEngines ?? [],
        not_observed_engines: requestedEngines?.filter((engine) => !preModeSuccessfulEngines.has(engine)) ?? [],
        unmeasured_scoped_engines: requestedEngines?.filter((engine) =>
          preModeSuccessfulEngines.has(engine) && !usableEngines.has(engine)) ?? [],
        note: requestedEngines
          ? 'Only selected engines contribute to comparison shares, prompt rankings and coverage. Requested engines without successful stored responses, or with only mode/identity/prompt-filtered evidence, are unmeasured, not observed zeros. No provider scans were requested.'
          : 'Comparison uses all stored engines in the selected window. Omit engines or pass [] to retain the historical default; no provider scans were requested.',
      };
      const measurement_scope = {
        measurement_mode_filter: measurement_mode ?? null,
        excluded_mode_responses: excludedModeResponses,
        note: measurement_mode
          ? 'Only this stored request mode contributes to shares, rankings and coverage; excluded responses are not observed zeros. Search-requested does not prove a source was cited. No provider calls.'
          : 'The historical default combines model-only and search-requested observations; use measurement_mode for a like-for-like subset. No provider calls.',
      };
      const prompt_set_scope = {
        selection: active_prompts_only ? 'active_only' as const : 'full_window' as const,
        active_prompt_count: activePromptIds?.size ?? null,
        excluded_observations: currentIdentityResponses.length - allResponses.length,
        note: active_prompts_only
          ? 'Only successful observations for currently active prompt IDs were compared. Retired prompt evidence remains stored in history; no fresh provider measurements were requested.'
          : 'The full historical window may include retired buyer questions. Set active_prompts_only=true to restrict comparison shares and prompt rankings to the current prompt set.',
      };
      const identity_attribution = {
        last_identity_change_at: lastIdentityChangeAt,
        excluded_responses: excludedResponses,
        note: identityChangedAt === null
          ? 'No recorded brand matching-identity boundary is available; earlier identity edits cannot be reconstructed.'
          : 'Comparison shares and prompt rankings exclude observations from runs started before the latest recorded brand matching-identity edit, or with no verifiable run start. Old observations remain in history; run start, not response capture, determines attribution.',
      };
      const evidenceByEngine = new Map<string, {
        successfulResponses: number;
        runs: Set<string>;
        prompts: Set<string>;
        lastObservedAt: number;
      }>();
      for (const row of allResponses) {
        const existing = evidenceByEngine.get(row.engine) ?? {
          successfulResponses: 0,
          runs: new Set<string>(),
          prompts: new Set<string>(),
          lastObservedAt: row.captured_at,
        };
        existing.successfulResponses++;
        existing.runs.add(row.run_id);
        existing.prompts.add(row.prompt_id);
        existing.lastObservedAt = Math.max(existing.lastObservedAt, row.captured_at);
        evidenceByEngine.set(row.engine, existing);
      }
      const perEngineEvidence = [...evidenceByEngine.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([engine, evidence]) => ({
          engine,
          successful_responses: evidence.successfulResponses,
          distinct_runs: evidence.runs.size,
          distinct_prompts: evidence.prompts.size,
          last_observed_at: new Date(evidence.lastObservedAt).toISOString(),
        }));
      const observation_coverage = allResponses.length === 0
        ? {
            status: 'no_observations' as const,
            successful_responses: 0,
            per_engine: perEngineEvidence,
            note: 'No usable current-identity AI responses were recorded in this window; zero shares are not measured absence.',
          }
        : {
            status: 'observed' as const,
            successful_responses: allResponses.length,
            per_engine: perEngineEvidence,
            note: 'Shares use the latest successful response per run, engine and prompt. Per-engine counts show unequal observed sampling across all runs; distinct prompts and run counts do not establish complete prompt or engine coverage. Unlisted engines may be unconfigured, unscanned or failed.',
          };

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
          prompts_won_against_you: [...wonPrompts.entries()]
            .sort(([idA, textA], [idB, textB]) =>
              textA.localeCompare(textB) || idA.localeCompare(idB))
            .slice(0, 5)
            .map(([, text]) => text),
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
        r: ComparisonEvidenceRow,
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
      const topPrompts = (map: Map<string, ComparedPrompt>) => [...map.entries()]
        .sort(([idA, a], [idB, b]) =>
          b.engines.size - a.engines.size ||
          a.prompt.localeCompare(b.prompt) ||
          idA.localeCompare(idB))
        .slice(0, 5)
        .map(([, w]) => ({
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
        identity_attribution,
        observation_coverage,
        google_search_sampling: googleSearchSampling(allResponses.map(({ engine }) => engine)),
        your_share_of_voice_pct: pct(brandMentions),
        your_mentions: brandMentions,
        comparison_semantics: COMPARISON_SEMANTICS,
        historical_coverage_note: COMPARISON_HISTORY_CAVEAT,
        outside_current_tracking: outsideCurrentTracking,
        prompt_set_scope,
        engine_scope,
        measurement_scope,
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
        "Page stored citations and source rankings. engines selects audit surfaces; measurement_mode selects model-only or search-requested evidence before pagination. Defaults retain history. No provider scans. Example: brand_id='acme'.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to inspect.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(14)
          .describe('Previous days to search.'),
        engine: engineSchema
          .optional()
          .describe('Legacy single-engine selection; do not combine with nonempty engines.'),
        engines: z.array(engineSchema).optional()
          .describe('Selected audit engines; omitted/[] preserves all-engine defaults. Do not combine with engine.'),
        measurement_mode: z.enum(['model_only', 'search_requested']).optional()
          .describe('Filter pages and top_sources by request mode; search_requested does not verify source links.'),
        limit: z.number().int().min(1).max(100).default(50)
          .describe('Citation rows per page, 1-100 (default 50).'),
        current_identity_only: z.boolean().default(false)
          .describe('Filter citations and source rankings to current-brand runs when the identity boundary is known.'),
        active_prompts_only: z.boolean().default(false)
          .describe('Filter citations and source rankings to currently active buyer questions without new provider scans.'),
        cursor: z.string().max(1600).optional()
          .describe('Opaque next_cursor; preserve brand, days, engine/engines, identity and prompt selection.'),
      },
      outputSchema: citationsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, days = 14, engine, engines, measurement_mode, limit = 50, current_identity_only = false,
      active_prompts_only = false, cursor }) => {
      const selectedEngines = [...new Set(engines ?? [])].sort();
      if (engine && selectedEngines.length) {
        throw new Error('Select either engine or engines, not both.');
      }
      const engineSelection = engine ?? (selectedEngines.length ? selectedEngines : undefined);
      const requestedEngines = engine ? [engine] : selectedEngines;
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const identityBoundary = brand.identity_changed_at ?? null;
      const minRunStartedAt = current_identity_only && identityBoundary !== null
        ? identityBoundary : undefined;
      const activePrompts = active_prompts_only ? await deps.db.getActivePrompts(brand_id) : null;
      // Scope cursors to the roster seen on page one; a prompt edit invalidates pagination.
      const promptRosterDigest = activePrompts === null ? null : await citationPromptRosterDigest(activePrompts);
      const now = Date.now();
      const previous = cursor ? decodeCitationCursor(
        cursor, brand_id, days, engine ?? null, selectedEngines, measurement_mode, current_identity_only, identityBoundary,
        active_prompts_only, promptRosterDigest,
      ) : null;
      const since = previous?.since ?? (now - days * 86_400_000);
      const until = previous?.until ?? now;
      // Query one extra row to tell the caller whether another page exists.
      const rows = await deps.db.getCitationRows(brand_id, since, engineSelection, {
        until,
        before: previous?.before,
        limit: limit + 1,
        minRunStartedAt,
        activePromptsOnly: active_prompts_only,
        measurementMode: measurement_mode,
      });
      const hasMore = rows.length > limit;
      const results = rows.slice(0, limit);
      const sourceResponses = await deps.db.getCitationSourceRows(
        brand_id, since, until, engineSelection, minRunStartedAt, active_prompts_only, measurement_mode,
      );

      const citations = results.map((row) => {
        const engineHosts = parseStringArray(row.engine_citations_json);
        const brandUrl = pickBrandUrl(brand, engineHosts, row.raw_response);
        return {
          id: citationId(row.response_id),
          engine: row.engine,
          prompt: row.prompt,
          cited_at: new Date(row.captured_at).toISOString(),
          citation_type:
            row.brand_mentioned !== 1 && row.brand_cited_with_link === 1
              ? 'source_link_only'
              : row.brand_cited_with_link === 1
              ? 'mention_with_link'
              : 'mention_without_link',
          measurement_mode: visibilityMeasurementMode(row.engine, row.mode ?? 'live'),
          ...(identityBoundary !== null
            ? { identity_scope: citationIdentityScope(row.run_started_at, identityBoundary) }
            : {}),
          response_excerpt: buildResponseExcerpt(row.raw_response, brand),
          cited_url: brandUrl?.url ?? null,
          url_source: brandUrl?.source ?? null,
        };
      });

      const payload = {
        brand_id,
        days,
        engine: engine ?? null,
        measurement_mode_filter: measurement_mode ?? null,
        engine_scope: {
          selection: requestedEngines.length ? 'selected' as const : 'all_stored' as const,
          requested_engines: requestedEngines,
          not_observed_engines: requestedEngines.filter((selected) =>
            !sourceResponses.some((response) => response.engine === selected)),
          note: 'Citation pages and source rankings use only the requested stored engines before limits and aggregation. Missing successful responses in this window are not measured zero, proof a provider was configured, or proof a scan was attempted.',
        },
        identity_attribution: identityBoundary === null ? null : {
          identity_changed_at: new Date(identityBoundary).toISOString(),
          note: minRunStartedAt === undefined
            ? 'Citation rows and top sources preserve the historical window, including prior tracked identities. Historical and unattributed evidence is not proof of current-brand visibility. Identity scope uses run start.'
            : 'Citation pages and top sources include only observations whose originating run started after the recorded brand identity change. Unknown run starts and old identities are excluded; this does not establish fresh measurement.',
        },
        identity_filter: {
          selection: current_identity_only ? 'current_identity_only' as const : 'full_history' as const,
          applied: minRunStartedAt !== undefined,
          note: minRunStartedAt !== undefined
            ? 'Filtered on originating run start before pagination and source aggregation; historical and unattributed evidence excluded.'
            : current_identity_only
              ? 'No recorded matching-identity boundary; current-only filtering cannot be established, so full historical evidence is returned.'
              : 'Full historical evidence retained. Opt into current_identity_only for a matching-identity cohort when the boundary is known.',
        },
        prompt_set_scope: {
          selection: active_prompts_only ? 'active_only' as const : 'full_history' as const,
          active_prompt_count: activePrompts?.length ?? null,
          note: active_prompts_only
            ? 'Citation pages and source rankings include only currently active buyer prompts. Earlier measurements of those same questions remain historical, not new scans; retired prompts are excluded before pagination and aggregation.'
            : 'Full historical buyer-prompt evidence retained, including retired questions. Set active_prompts_only=true for current buyer questions without provider requests.',
        },
        google_search_sampling: googleSearchSampling([
          ...requestedEngines,
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
              ...(selectedEngines.length ? { engines: selectedEngines } : {}),
              ...(measurement_mode ? { measurement_mode } : {}),
              identity_selection: current_identity_only ? 'current_identity_only' : 'full_history',
              identity_boundary: current_identity_only ? identityBoundary : null,
              prompt_selection: active_prompts_only ? 'active_only' : 'full_history',
              prompt_roster_digest: promptRosterDigest,
              since,
              until,
              before: {
                captured_at: results[results.length - 1].captured_at,
                run_id: results[results.length - 1].run_id,
                prompt_id: results[results.length - 1].prompt_id,
                response_id: results[results.length - 1].response_id,
              },
            }))
          : null,
        top_sources: buildTopSources(sourceResponses, brand, identityBoundary),
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
        "Prioritize observed competitor-winning prompts. engines restricts stored audit surfaces; omitted/[] uses all. Provider-free by default; ai_analysis=true opts in to token-billed Claude (may retry once). Example: brand_id='acme'.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to analyze.'),
        engines: z.array(engineSchema).optional()
          .describe('Only recommend from these engines; omit or pass [] to retain all-engine defaults.'),
        max_recommendations: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe('Maximum recommendations to return (integer, 1-10).'),
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
    async ({ brand_id, engines, max_recommendations, ai_analysis }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const requestedEngines = engines && engines.length > 0 ? uniqueEngineNames(engines) : null;
      const selectedEngines = requestedEngines ?? ALL_ENGINES;
      const recordedRunEngines = new Set<string>();
      const usableEngines = new Set<string>();

      // Retired prompt observations remain in history, but must not become
      // current buyer-intent advice after the active prompt set is replaced.
      const activePromptIds = new Set(
        (await deps.db.getActivePrompts(brand_id)).map((prompt) => prompt.id),
      );
      // Earlier scans may retain competitors removed by update_brand. Content
      // gaps must reflect the brand's currently configured comparison cohort.
      const trackedCompetitors = new Set(brand.competitors);
      const identityChangedAt = brand.identity_changed_at ?? null;
      const staleIdentityEngines: string[] = [];
      const staleSettingsEngines = new Set<string>();
      const lossModeByEngine = new Map<string, 'search_requested' | 'model_only'>();
      const losingByPrompt = new Map<
        string,
        {
          prompt_text: string;
          engines: Set<string>;
          competitors: Set<string>;
          observations: Map<string, {
            engine: string;
            run_id: string;
            response_id: string;
            captured_at_ms: number;
            competitors_mentioned: string[];
          }>;
        }
      >();
      let successfulResponses = 0;
      const perEngineCoverage: Array<{
        engine: string; run_id: string; refreshed_at: string | null; usable_prompt_count: number;
        missing_prompt_count: number;
      }> = [];
      for (const engine of selectedEngines) {
        const run = await deps.db.getLatestCompletedRun(brand_id, engine);
        if (!run) continue;
        recordedRunEngines.add(engine);
        // Before an identity change these responses were classified using
        // another name/domain/alias set. Keep them in history, not new advice.
        if (identityChangedAt !== null && run.started_at < identityChangedAt) {
          staleIdentityEngines.push(engine);
          continue;
        }
        const responses = await deps.db.getResponsesForRun(run.id);
        // Retain history for evidence, but use only each prompt's latest
        // successful result when determining current content-gap advice.
        const latestOkByPrompt = new Map<string, PromptResponse>();
        for (const response of responses) {
          if (response.status !== 'ok' || !activePromptIds.has(response.prompt_id)) continue;
          const previous = latestOkByPrompt.get(response.prompt_id);
          if (!previous ||
              response.captured_at > previous.captured_at ||
              (response.captured_at === previous.captured_at && response.id > previous.id)) {
            latestOkByPrompt.set(response.prompt_id, response);
          }
        }
        if (latestOkByPrompt.size > 0) usableEngines.add(engine);
        // Report the denominator independently of whether any competitor won.
        // An observed loss on one prompt is not evidence of complete coverage.
        const refreshedAtMs = run.completed_at ?? run.started_at;
        perEngineCoverage.push({
          engine, run_id: run.id,
          refreshed_at: Number.isFinite(refreshedAtMs) &&
            Math.abs(refreshedAtMs) <= 8.64e15
            ? new Date(refreshedAtMs).toISOString() : null,
          usable_prompt_count: latestOkByPrompt.size,
          missing_prompt_count: activePromptIds.size - latestOkByPrompt.size,
        });
        // A settings edit cannot retroactively change an earlier scan. Warn
        // only for engines with usable active-prompt evidence in this analysis.
        if (latestOkByPrompt.size > 0 && Number.isFinite(run.started_at) &&
            Number.isFinite(brand.updated_at) && run.started_at < brand.updated_at) {
          staleSettingsEngines.add(engine);
        }
        for (const r of latestOkByPrompt.values()) {
          successfulResponses++;
          if (r.brand_mentioned !== 0) continue;
          const currentMentions = r.competitors_mentioned.filter((c) => trackedCompetitors.has(c));
          if (currentMentions.length === 0) continue;
          // Identifiers only: these are traceable stored observations, not
          // independently verified source citations or copied model answers.
          const observation = {
            engine: r.engine,
            run_id: run.id,
            response_id: r.id,
            captured_at_ms: r.captured_at,
            competitors_mentioned: [...new Set(currentMentions)].sort(),
          };
          lossModeByEngine.set(engine, visibilityMeasurementMode(engine, run.mode ?? 'live'));
          const existing = losingByPrompt.get(r.prompt_id);
          if (existing) {
            existing.engines.add(r.engine);
            existing.observations.set(engine, observation);
            for (const c of currentMentions) {
              existing.competitors.add(c);
            }
          } else {
            losingByPrompt.set(r.prompt_id, {
              prompt_text: r.prompt_text,
              engines: new Set([r.engine]),
              competitors: new Set(currentMentions),
              observations: new Map([[engine, observation]]),
            });
          }
        }
      }
      const losingPrompts = [...losingByPrompt.entries()]
        .map(([prompt_id, l]) => ({
          prompt_id,
          prompt_text: l.prompt_text,
          engines_lost_on: [...l.engines].sort(),
          competitors_winning: [...l.competitors].sort(),
          observations: [...l.observations.values()]
            .sort((a, b) => a.engine.localeCompare(b.engine)),
        }))
        .sort(
          (a, b) =>
            b.competitors_winning.length - a.competitors_winning.length ||
            b.engines_lost_on.length - a.engines_lost_on.length ||
            a.prompt_text.localeCompare(b.prompt_text),
        )
        .slice(0, 15);
      const losing_prompt_evidence = {
        note: 'These are stored response record references for observed competitor-only mentions in the current active prompt set, not independently verified source citations. No raw model answers are included; inspect stored responses before quoting any evidence in a client audit.',
        prompts: losingPrompts.map(({ prompt_id, prompt_text, observations }) => ({
          prompt_id, prompt_text, observations,
        })),
      };
      const observation_coverage = {
        active_prompt_count: activePromptIds.size,
        per_engine: perEngineCoverage,
        incomplete_engines: perEngineCoverage
          .filter(({ missing_prompt_count }) => missing_prompt_count > 0)
          .map(({ engine }) => engine),
        unmeasured_engines: selectedEngines.filter(
          (engine) => !perEngineCoverage.some(
            (entry) => entry.engine === engine && entry.usable_prompt_count > 0)),
        note: 'Counts are unique currently active prompts with a successful stored response after any recorded brand identity change, not verified citations or a confidence score. Per-engine refreshed_at is the run completion time (or start if unfinished), not proof that all prompts succeeded. unmeasured_engines cover the selected engine scope and include engines excluded for stale identity or with zero usable active-prompt responses; others may be unconfigured or unscanned. Refreshing incomplete engines may incur provider charges.',
      };
      const engine_scope = {
        selection: requestedEngines ? 'selected' as const : 'all_stored' as const,
        requested_engines: requestedEngines ?? [],
        not_observed_engines: requestedEngines?.filter((engine) =>
          !recordedRunEngines.has(engine)) ?? [],
        unmeasured_scoped_engines: requestedEngines?.filter((engine) =>
          recordedRunEngines.has(engine) && !usableEngines.has(engine)) ?? [],
        note: requestedEngines
          ? 'Only selected stored engines contribute to recommendations, observation coverage, evidence and Google sampling. Requested engines without a latest eligible run, or with only identity/active-prompt-excluded evidence, are unmeasured rather than zero visibility. No provider refresh was requested.'
          : 'All supported engines are considered using the historical stored-evidence default. Omit engines or pass [] for this behavior; no provider refresh was requested.',
      };

      const losingEngines = [...new Set(losingPrompts.flatMap((p) => p.engines_lost_on))];
      const searchRequestedEngines = losingEngines.filter(
        (engine) => lossModeByEngine.get(engine) === 'search_requested',
      ).sort();
      const modelOnlyEngines = losingEngines.filter(
        (engine) => lossModeByEngine.get(engine) === 'model_only',
      ).sort();
      const measurement_scope = {
        search_requested_engines: searchRequestedEngines,
        model_only_engines: modelOnlyEngines,
        mixed_modes: searchRequestedEngines.length > 0 && modelOnlyEngines.length > 0,
        note: 'Engines contributing competitor-only losses are grouped by request path. Search-requested does not prove a source citation was returned; model-only observations are not live AI-search evidence. Review the stored answers before using recommendations in a client audit.',
      };
      const enginesScannedBeforeUpdate = [...staleSettingsEngines].sort();
      const configuration_comparability = {
        brand_updated_at: Number.isFinite(brand.updated_at)
          ? new Date(brand.updated_at).toISOString() : null,
        engines_scanned_before_update: enginesScannedBeforeUpdate,
        historical_settings_warning: enginesScannedBeforeUpdate.length > 0,
        note: 'The listed engines have usable observations from runs started before the latest brand settings update. Recommendations can therefore reflect earlier brand identity, category, aliases, exclusions or competitors. The database cannot determine which field changed; a cadence-only edit may not affect the evidence. Review the change and refresh affected engines before treating recommendations as current-configuration findings; refresh may incur provider charges.',
      };
      const identity_attribution = {
        last_identity_change_at: identityChangedAt === null
          ? null : new Date(identityChangedAt).toISOString(),
        stale_engines: staleIdentityEngines.sort(),
        note: 'Scans begun before the last brand name/domain/alias/exclusion change are excluded from current content-gap recommendations and coverage. Those stored observations remain in history, not new-brand evidence; refresh after identity changes if needed (provider charges may apply). Earlier changes before identity-boundary migration are unknown.',
      };
      // Google locale limits apply to usable observations even when no
      // competitor-only losses were found in those observations.
      const google_search_sampling = googleSearchSampling(perEngineCoverage
        .filter(({ usable_prompt_count }) => usable_prompt_count > 0)
        .map(({ engine }) => engine));

      if (losingPrompts.length === 0) {
        const payload = {
          brand_id,
          engine_scope,
          google_search_sampling,
          observation_coverage,
          losing_prompt_evidence,
          configuration_comparability,
          identity_attribution,
          measurement_scope,
          recommendations: [],
          prompt_source: 'fallback' as const,
          reason: successfulResponses === 0
            ? staleIdentityEngines.length > 0
              ? 'No usable current-identity scan responses for active prompts. Old identity observations were excluded; a refresh can collect new evidence but may incur provider charges.'
              : 'No usable scan responses for currently active prompts in the latest completed runs. A refresh can collect evidence but may incur provider charges.'
            : `No competitor-only wins observed in ${successfulResponses} usable responses. This does not prove complete prompt or engine coverage.`,
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
        engine_scope,
        observation_coverage,
        configuration_comparability,
        identity_attribution,
        losing_prompt_evidence,
        measurement_scope,
        google_search_sampling,
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
          .min(1)
          .optional()
          .describe('Engines to run (at least one); omit for every configured engine.'),
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
      if (requested?.length === 0) {
        throw new Error('Select at least one engine or omit engines to refresh every configured engine.');
      }
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
      const category_missing = !brand.category?.trim();
      const prompts_naming_brand = prompts.filter((prompt) =>
        findTermSetMatchIndex(prompt.text, {
          domain: brand.domain,
          name: brand.name,
          aliases: [],
          excludeTerms: [],
        }) !== -1,
      ).length;
      const review_recommended = category_missing || prompts_naming_brand > 0;
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
        prompt_review: {
          category_missing,
          prompts_naming_brand,
          review_recommended,
          note: review_recommended
            ? 'Review active prompts before provider-backed scans: a missing category or questions naming the tracked brand can bias an unprompted visibility baseline. Brand-specific questions may be intentional; this is advisory, not a rejection.'
            : 'No missing-category or brand-name warning detected. Prompt representativeness and buyer intent have not been independently validated; review before provider-backed scans.',
        },
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

function citationId(responseId: string): string {
  // A run can retain multiple observations for the same prompt.
  return `cit_${responseId}`;
}

type CitationIdentityScope = 'current' | 'historical' | 'unattributed';

function citationIdentityScope(startedAt: number | null | undefined, boundary: number): CitationIdentityScope {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return 'unattributed';
  return startedAt < boundary ? 'historical' : 'current';
}

function buildTopSources(responses: CitationSourceRow[], brand: Brand, identityBoundary: number | null = null) {
  const sources = new Map<
    string,
    {
      citation_count: number;
      prompts: Set<string>;
      engines: Set<string>;
      measurement_modes: Set<'model_only' | 'search_requested'>;
      identity_scopes: Set<CitationIdentityScope>;
      sample_url: string;
      sample_captured_at: number;
      sample_response_id: string;
    }
  >();

  for (const response of responses) {
    const domainsForResponse = new Map<string, string>();
    const identityScope = identityBoundary === null
      ? null : citationIdentityScope(response.run_started_at, identityBoundary);
    for (const rawUrl of response.engine_citations) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
        if (parsed.username || parsed.password) continue;
        // A provider URL can name localhost, an IP or an invalid DNS host.
        // Only rank domain-shaped sources using the same host rules as brands.
        const domain = normalizeDomainInput(parsed.hostname);
        if (!domain) continue;
        if (!domainsForResponse.has(domain)) domainsForResponse.set(domain, rawUrl);
      } catch {
        // Provider-native citation payloads are external data. Ignore malformed
        // entries rather than letting one bad source hide the usable evidence.
      }
    }

    for (const [domain, sampleUrl] of domainsForResponse) {
      const existing = sources.get(domain);
      const measurementMode = visibilityMeasurementMode(response.engine, response.mode ?? 'live');
      if (existing) {
        existing.citation_count += 1;
        existing.prompts.add(response.prompt_id);
        existing.engines.add(response.engine);
        existing.measurement_modes.add(measurementMode);
        if (identityScope !== null) existing.identity_scopes.add(identityScope);
        // A source sample must not depend on database row ordering. Prefer
        // the newest observation, then a stable ID for tied timestamps.
        if (
          response.captured_at > existing.sample_captured_at ||
          (response.captured_at === existing.sample_captured_at &&
            response.id < existing.sample_response_id)
        ) {
          existing.sample_url = sampleUrl;
          existing.sample_captured_at = response.captured_at;
          existing.sample_response_id = response.id;
        }
      } else {
        sources.set(domain, {
          citation_count: 1,
          prompts: new Set([response.prompt_id]),
          engines: new Set([response.engine]),
          measurement_modes: new Set([measurementMode]),
          identity_scopes: new Set(identityScope === null ? [] : [identityScope]),
          sample_url: sampleUrl,
          sample_captured_at: response.captured_at,
          sample_response_id: response.id,
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
      measurement_modes: [...source.measurement_modes].sort(),
      ...(identityBoundary !== null ? { identity_scopes: [...source.identity_scopes].sort() } : {}),
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
