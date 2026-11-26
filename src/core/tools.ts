// The seven shared MCP tools (registerTools) plus the six CLI-only
// management tools (registerLocalManagementTools), registered against
// any McpServer. The shared seven are wired verbatim
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
  score_uncertainty: z.object({
    minimum: z.number(),
    maximum: z.number(),
    partial_engines: z.array(z.string()),
    by_engine: z.array(z.object({
      engine: z.string(),
      observed_score: z.number(),
      minimum: z.number(),
      maximum: z.number(),
      usable_prompts: z.number(),
      expected_prompts: z.number(),
    })),
    by_measurement_mode: z.object({
      search_requested: z.object({
        minimum: z.number(), maximum: z.number(), partial_engines: z.array(z.string()),
      }).nullable(),
      model_only: z.object({
        minimum: z.number(), maximum: z.number(), partial_engines: z.array(z.string()),
      }).nullable(),
    }),
    note: z.string(),
  }),
  missing_requested_engines: z.array(z.string()),
  unmeasured_engines: z.array(z.string()),
  unmeasured_engine_reasons: z.array(z.object({
    engine: z.string(),
    reason: z.enum([
      'incompatible_mode_selection',
      'no_eligible_stored_run',
      'no_stored_responses',
      'stale_brand_identity',
      'no_successful_active_prompt_observations',
      'no_usable_stored_responses',
    ]),
  })),
  unmeasured_engines_note: z.string(),
  measurement_scope: z.object({
    measurement_mode_filter: z.enum(['model_only', 'search_requested']).nullable(),
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
  you_mentioned_by: z.array(z.string()),
  competitors_mentioned: z.array(z.string()),
  // Kept for existing MCP clients; these legacy names describe mentions, not citations.
  you_cited_by: z.array(z.string()),
  competitors_cited: z.array(z.string()),
});

const comparisonEvidenceSampleSchema = z.object({
  engine: z.string(),
  run_id: z.string(),
  response_id: z.string(),
  prompt_id: z.string(),
  prompt: z.string(),
  measurement_mode: z.enum(['model_only', 'search_requested']),
  captured_at: z.string(),
});

const observationEvidenceOutputSchema = z.object({
  brand_id: z.string(),
  run_id: z.string(),
  response_id: z.string(),
  engine: z.string(),
  prompt_id: z.string(),
  prompt: z.string(),
  captured_at: z.string().nullable(),
  status: z.literal('ok'),
  measurement_mode: z.enum(['model_only', 'search_requested']),
  identity_scope: z.enum(['current_identity', 'historical_identity', 'unknown_boundary']),
  active_prompt: z.boolean(),
  brand_mentioned: z.boolean(),
  competitors_mentioned: z.array(z.string()),
  response_excerpt: z.string().max(250),
  requested_competitor: z.string().nullable(),
  provider_source_count: z.number().int().nonnegative(),
  provider_source_urls_filtered_count: z.number().int().nonnegative(),
  provider_source_urls_deduplicated_count: z.number().int().nonnegative(),
  provider_source_urls_truncated: z.boolean(),
  provider_source_urls: z.array(z.object({
    url: z.string(),
    url_redacted: z.boolean(),
  })).max(5),
  google_search_sampling: googleSearchSamplingSchema,
  evidence_note: z.string(),
});

const COMPARISON_SEMANTICS =
  'Legacy prompts_you_win includes all brand-mentioned prompts, including co-mentions. ' +
  'prompts_brand_only and prompts_co_mentioned classify individual engine responses; ' +
  'a prompt can occur in both when engines differ. ' +
  'prompts_won_against_you lists competitor mentions where the tracked brand is absent. ' +
  'Use you_mentioned_by and competitors_mentioned for actual mention evidence; ' +
  'legacy you_cited_by and competitors_cited mean mentions, not verified source citations. ' +
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
  mention_evidence_samples: z.object({
    brand: z.array(comparisonEvidenceSampleSchema).max(5),
    competitors: z.array(z.object({
      domain: z.string(),
      samples: z.array(comparisonEvidenceSampleSchema).max(5),
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
  observation_coverage: z.object({
    per_engine: z.array(z.object({
      engine: z.string(),
      successful_observation_count: z.number().int().nonnegative(),
      distinct_prompt_count: z.number().int().nonnegative(),
      last_observed_at: z.string().nullable(),
    })),
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
  total_matching_rows: z.number().int().nonnegative(),
  total_matching_rows_note: z.string(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  top_sources_limit: z.number().int().min(1).max(50).describe('Maximum ranked source domains returned; default 10, maximum 50.'),
  total_source_domains: z.number().int().nonnegative().describe('All valid distinct cited domains in the selected stored window, before the ranked-source cap or exact-domain lookup.'),
  top_sources_truncated: z.boolean().describe('True when ranked source domains are omitted by top_sources_limit; citation pagination does not expand this summary.'),
  ranked_source_domain_filter: z.string().nullable().describe('Optional exact domain lookup applied only to the ranked source summary, not citation rows or full-window evidence counts.'),
  ranked_source_domain_match_found: z.boolean().describe('True when the requested domain was observed in the selected window; false with no lookup or no match is not a universal non-citation claim.'),
  top_sources: z.array(
    z.object({
      domain: z.string(),
      citation_count: z.number().describe('Stored responses listing this domain, at most once per response; not unique URLs.'),
      per_engine_citation_count: z.record(z.string(), z.number().int().nonnegative()).describe('Stored response-domain observations by engine, counted once per response and summing to citation_count; not unique links or verified live citations.'),
      per_engine_source_observation_percent: z.record(z.string(), z.number().min(0).max(100)).describe('Percent of successful stored responses on each cited engine that list this source domain, before page limits; not a brand visibility score or verified live citation rate.'),
      per_engine_distinct_prompt_count: z.record(z.string(), z.number().int().nonnegative()).describe('Distinct stored prompt IDs citing this domain on each engine; repeated observations of the same prompt count once per engine. Not unique question wording or a citation rate.'),
      per_engine_last_observed_at: z.record(z.string(), z.string()).describe('Latest stored capture time citing this source domain on each engine within the selected evidence scope; not independent proof that links remain live or still cited.'),
      per_engine_examples: z.record(z.string(), z.object({
        sample_url: z.string(),
        url_redacted: z.boolean(),
        run_id: z.string().describe('Stored run for this engine source sample; use with brand_id and response_id in get_observation_evidence.'),
        response_id: z.string().describe('Exact stored response for this engine source sample; not a verified live citation.'),
      })).describe('One deterministic URL cited for this domain on each observed engine, from its latest stored response; sensitive parameters masked, not a verified live link.'),
      distinct_cited_path_count: z.number().int().nonnegative().describe('Distinct cited URL pathnames for this domain, ignoring query and fragment; not verified live pages.'),
      top_cited_paths: z.array(z.object({
        path: z.string(),
        response_count: z.number().int().nonnegative(),
      })).max(5).describe('Up to five observed URL pathnames for this domain by stored response count, then path. One count per pathname per response; multiple different paths in one response can count separately. Query and fragment excluded; not verified live pages.'),
      prompt_count: z.number(),
      last_observed_at: z.string().describe('Latest stored source observation capture time; not proof the URL is currently live.'),
      engines: z.array(z.string()),
      measurement_modes: z.array(z.enum(['model_only', 'search_requested'])),
      sample_url: z.string(),
      url_redacted: z.boolean().describe('True when credential parameters were masked; the displayed sample may not be navigable.'),
      is_brand_domain: z.boolean(),
      identity_scopes: z.array(z.enum(['current', 'historical', 'unattributed'])).optional(),
    }),
  ),
  citations: z.array(
    z.object({
      id: z.string(),
      run_id: z.string().describe('Stored run ID; pair with response_id and brand_id in get_observation_evidence.'),
      response_id: z.string().describe('Exact stored response ID for get_observation_evidence; not an independently verified citation.'),
      engine: z.string(),
      prompt: z.string(),
      cited_at: z.string(),
      citation_type: z.string(),
      measurement_mode: z.enum(['model_only', 'search_requested']),
      identity_scope: z.enum(['current', 'historical', 'unattributed']).optional(),
      response_excerpt: z.string(),
      cited_url: z.string().nullable(),
      url_redacted: z.boolean().describe('True when credential parameters were masked; the displayed citation URL may not be navigable.'),
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
  ranked_source_domain: z.string().nullable().optional(),
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
  rankedSourceDomain: string | null,
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
      (parsed.ranked_source_domain ?? null) !== rankedSourceDomain ||
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
    throw new Error('Invalid citation cursor. Start again without cursor or preserve the brand, days, engine/engines, measurement mode, ranked source domain, identity and prompt selection.');
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
        measurement_mode: z.enum(['model_only', 'search_requested']),
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
    measurement_mode_filter: z.enum(['model_only', 'search_requested']).nullable(),
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
  failed_engines: z.array(z.string()).optional(),
  skipped_unconfigured_engines: z.array(z.string()),
  estimated_completion_seconds: z.number(),
  preview_only: z.boolean().optional(),
  planned_engines: z.array(z.string()).optional(),
  active_prompt_count: z.number().optional(),
  planned_prompt_engine_pairs: z.number().optional(),
  cost_note: z.string().optional(),
  ready_to_refresh: z.boolean().optional(),
  readiness_warnings: z.array(z.string()).optional(),
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
  get_observation_evidence: 'visibility.observation_evidence',
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
  const emptyVisibilityPreviewHint = `Call ${toolName('refresh_brand')} with preview_only=true to review configured engines and active prompts without provider requests. Start a real refresh only after reviewing potential provider charges.`;
  const refreshCostNote = ' Provider API requests may incur charges. Retries rerun every active prompt, including prior successes.';
  const refreshDescription = refreshIsAsync
    ? "Start scans; returns run IDs immediately." + refreshCostNote + " Set preview_only=true for a no-call scope preview. Example: brand_id='acme'."
    : "Scan; return after completion." + refreshCostNote + " Set preview_only=true for a no-call scope preview. Example: brand_id='acme'.";

  server.registerTool(
    toolName('check_visibility'),
    {
      title: 'Check AI visibility',
      description:
        "Read stored scores. engines selects surfaces; measurement_mode selects model-only or search-requested evidence. run_mode selects live/batch dispatch. Defaults retain history; no provider calls. Example: brand_id='acme'.",
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
        measurement_mode: z.enum(['model_only', 'search_requested']).optional()
          .describe('Select latest stored model-only or search-requested evidence per engine; omit for mixed history.'),
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
    async ({ brand_id, engines, run_mode, measurement_mode, active_prompts_only = false }) => {
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
      const unmeasuredReasonByEngine = new Map<string, string>();
      const measurementModeByEngine = new Map<string, 'search_requested' | 'model_only'>();
      let mostRecentTimestamp = 0;
      for (const engine of selectedEngines) {
        // Request mode is an evidence-path property, not identical to run
        // dispatch mode: Claude/Gemini live runs are still model-only.
        let eligibleRunMode = run_mode;
        if (measurement_mode === 'search_requested') {
          if (run_mode === 'batch' || engine === 'claude' || engine === 'gemini') {
            unmeasuredReasonByEngine.set(engine, 'incompatible_mode_selection');
            continue;
          }
          eligibleRunMode = 'live';
        } else if (measurement_mode === 'model_only' && engine !== 'claude' && engine !== 'gemini') {
          if (run_mode === 'live') {
            unmeasuredReasonByEngine.set(engine, 'incompatible_mode_selection');
            continue;
          }
          eligibleRunMode = 'batch';
        }
        const run = await deps.db.getLatestCompletedRun(brand_id, engine, eligibleRunMode);
        if (!run) {
          unmeasuredReasonByEngine.set(engine, 'no_eligible_stored_run');
          continue;
        }
        const responses = await deps.db.getResponsesForRun(run.id);
        if (responses.length === 0) {
          unmeasuredReasonByEngine.set(engine, 'no_stored_responses');
          continue;
        }
        // Stored mention flags were scored against the brand identity at scan
        // time. Do not attribute them to a later name/domain/alias revision.
        if (identityChangedAt !== null && run.started_at < identityChangedAt) {
          staleIdentityEngines.push(engine);
          unmeasuredReasonByEngine.set(engine, 'stale_brand_identity');
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
          throw new Error(`No current-identity visibility data for the selected engines. Stored scans predate the last brand name, domain, alias, or exclusion change. Historical runs remain available in get_visibility_history. ${emptyVisibilityPreviewHint}`);
        }
        if (measurement_mode) {
          throw new Error(`No usable stored visibility observations match the selected measurement_mode and run_mode for these engines. Missing evidence is unmeasured, not zero. ${emptyVisibilityPreviewHint}`);
        }
        throw new Error(
          engines && engines.length > 0
            ? `No visibility data yet for the selected engines. ${emptyVisibilityPreviewHint}`
            : `No visibility data yet for this brand. ${emptyVisibilityPreviewHint}`,
        );
      }
      const activePrompts = await deps.db.getActivePrompts(brand_id);
      const activePromptIds = new Set(activePrompts.map((prompt) => prompt.id));
      const scoredResponses = active_prompts_only
        ? selectedResponses.filter((row) => activePromptIds.has(row.prompt_id))
        : selectedResponses;
      const scored = computeOverallScore(brand, scoredResponses);
      // A failed-only snapshot is not evidence of zero brand visibility.
      if (scored.per_engine.length === 0) {
        if (active_prompts_only) {
          throw new Error(`No successful stored observations for currently active buyer prompts in the selected engines. Historical results remain available without active_prompts_only. ${emptyVisibilityPreviewHint}`);
        }
        throw new Error(`No successful stored visibility observations for the selected engines. Failed or incomplete runs are unmeasured, not zero. ${emptyVisibilityPreviewHint}`);
      }
      // A run may be marked complete long after an earlier successful answer
      // was persisted. Date the displayed evidence by its latest usable row,
      // not by a later status update (or by excluded retired prompts).
      const latestCapturedAtByEngine = new Map<string, number>();
      for (const row of scoredResponses) {
        if (row.status !== 'ok' || !Number.isFinite(row.captured_at) || row.captured_at <= 0) continue;
        const previous = latestCapturedAtByEngine.get(row.engine);
        if (previous === undefined || row.captured_at > previous) {
          latestCapturedAtByEngine.set(row.engine, row.captured_at);
        }
      }
      for (const { engine } of scored.per_engine) {
        const capturedAt = latestCapturedAtByEngine.get(engine);
        if (capturedAt === undefined) continue; // Older data may lack a usable capture timestamp.
        refreshMsByEngine.set(engine, capturedAt);
        refreshedAtByEngine.set(engine, new Date(capturedAt).toISOString());
      }
      const scoredEngines = new Set(scored.per_engine.map(({ engine }) => engine));
      // Failed-only engines are unmeasured even when they have a stored run;
      // they must not appear to have supplied a zero score or fresh evidence.
      const unmeasuredEngines = selectedEngines.filter((engine) =>
        !scoredEngines.has(engine));
      // Explain only what the selected stored evidence proves. Missing runs
      // do not establish whether a provider was configured or attempted.
      const unmeasuredEngineReasons = unmeasuredEngines.map((engine) => ({
        engine,
        reason: unmeasuredReasonByEngine.get(engine) ?? (active_prompts_only
          ? 'no_successful_active_prompt_observations'
          : 'no_usable_stored_responses'),
      }));
      const missingRequestedEngines = engines && engines.length > 0
        ? unmeasuredEngines
        : [];
      const scoredRefreshMs = [...refreshMsByEngine.entries()]
        .filter(([engine]) => scoredEngines.has(engine));
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
        .filter(([engine]) => scoredEngines.has(engine))
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

      // The headline score conditions on observed successful prompts. Give
      // clients deterministic extremes over each engine's missing prompt
      // slots instead of letting a 1-of-20 result appear fully measured.
      const possiblePerEngineScores = perEngine.map((engine) => {
        const expected = engine.coverage.expected_prompts;
        const missing = expected - engine.coverage.usable_prompts;
        const hits = engine.prompts_appeared_in;
        return {
          engine: engine.engine,
          observed_score: engine.score,
          minimum: expected === 0 ? 0 : Math.round(100 * hits / expected),
          maximum: expected === 0 ? 0 : Math.round(100 * (hits + missing) / expected),
          usable_prompts: engine.coverage.usable_prompts,
          expected_prompts: expected,
          partial: missing > 0,
        };
      });
      const averageExtreme = (
        scores: typeof possiblePerEngineScores, key: 'minimum' | 'maximum',
      ): number => scores.length === 0 ? 0 : Math.round(
        scores.reduce((sum, engine) => sum + engine[key], 0) / scores.length,
      );
      const modeBounds = (mode: 'search_requested' | 'model_only') => {
        const scores = possiblePerEngineScores.filter(
          (engine) => measurementModeByEngine.get(engine.engine) === mode,
        );
        return scores.length === 0 ? null : {
          minimum: averageExtreme(scores, 'minimum'),
          maximum: averageExtreme(scores, 'maximum'),
          partial_engines: scores.filter((engine) => engine.partial)
            .map((engine) => engine.engine).sort(),
        };
      };
      const score_uncertainty = {
        minimum: averageExtreme(possiblePerEngineScores, 'minimum'),
        maximum: averageExtreme(possiblePerEngineScores, 'maximum'),
        partial_engines: possiblePerEngineScores.filter((engine) => engine.partial)
          .map((engine) => engine.engine).sort(),
        by_engine: possiblePerEngineScores.map(({ partial, ...engine }) => engine)
          .sort((a, b) => a.engine.localeCompare(b.engine)),
        by_measurement_mode: {
          search_requested: modeBounds('search_requested'),
          model_only: modeBounds('model_only'),
        },
        note: 'These are deterministic best/worst-case bounds if every missing prompt in each scored engine were a brand mention or a non-mention, not a confidence interval or a forecast. by_engine identifies the observed and possible scores for each measured surface. by_measurement_mode separates search-requested from model-only scored engines; a null mode has no measured engines, not a zero score. Only scored engines contribute; unmeasured engines are excluded. Historical or changed prompt sets may not be directly comparable. No provider calls were made.',
      };

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
        score_uncertainty,
        missing_requested_engines: missingRequestedEngines,
        unmeasured_engines: unmeasuredEngines,
        unmeasured_engine_reasons: unmeasuredEngineReasons,
        unmeasured_engines_note: active_prompts_only
          ? 'These engines have no successful stored observations for currently active buyer prompts under the selected run and measurement modes and are excluded from overall_score. They are unmeasured, not observed zeros. A new scan may incur provider charges.'
          : 'These known or requested engines have no usable current-identity observations under the selected run and measurement modes and are excluded from overall_score. Stale identity engines are listed in identity_attribution; absence does not establish whether an engine was configured, attempted or failed.',
        measurement_scope: {
          measurement_mode_filter: measurement_mode ?? null,
          search_requested: searchRequested,
          model_only: modelOnly,
          mixed_modes: searchRequested.engines.length > 0 && modelOnly.engines.length > 0,
          note: 'Scores count brand mentions in the latest usable observation per distinct prompt and engine from each eligible stored run, not independently verified search citations. A measurement_mode filter selects matching evidence before scoring, even when a newer run has a different request mode; absent matching engines are unmeasured. Search-requested runs may return no source links. Claude/Gemini live runs and all batch runs are model-only; run_mode alone does not select a request mode. Omission retains historical mixed results; no provider calls occur.',
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
        top_winning_prompts: scored.top_winning_prompts.map((row) => ({
          ...row,
          prompt: redactEvidenceText(row.prompt),
        })),
        winning_prompt_evidence_note: 'engines_cited_in is a legacy field counting brand mentions in answers, not source citations. Use engines_mentioned_in for mention evidence and engines_with_brand_link for linked brand evidence. A link-only source without an answer mention is not a winning prompt.',
        top_losing_prompts: scored.top_losing_prompts.map((row) => ({
          ...row,
          prompt: redactEvidenceText(row.prompt),
        })),
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
        // Run completion can lag successful captures by hours or days.
        // Preserve completion-based chart buckets while dating evidence by
        // the latest eligible successful response in the selected cohort.
        const capturedAt = active_prompts_only
          ? row.active_last_captured_at : row.last_captured_at;
        const observedAt = new Date(
          typeof capturedAt === 'number' && Number.isFinite(capturedAt)
            ? capturedAt : row.completed_at,
        ).toISOString();
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
          mention_evidence_samples: {
            brand: [],
            competitors: [],
            note: 'No targets selected; no stored mention evidence was queried.',
          },
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
      // Sample only records that actually contribute to the scoped comparison
      // counts. Keep this bounded and omit raw model text from client reports.
      const sampleRows = [...allResponses].sort((a, b) =>
        b.captured_at - a.captured_at || b.id.localeCompare(a.id) ||
        a.engine.localeCompare(b.engine));
      const sampleReference = (row: ComparisonEvidenceRow) => ({
        engine: row.engine,
        run_id: row.run_id,
        response_id: row.id,
        prompt_id: row.prompt_id,
        prompt: redactEvidenceText(row.prompt_text),
        measurement_mode: visibilityMeasurementMode(row.engine, row.mode ?? 'live'),
        captured_at: new Date(row.captured_at).toISOString(),
      });
      const mention_evidence_samples = {
        brand: sampleRows.filter((row) => row.brand_mentioned === 1)
          .slice(0, 5).map(sampleReference),
        competitors: targets.map((domain) => ({
          domain,
          samples: sampleRows.filter((row) => row.competitors_mentioned.includes(domain))
            .slice(0, 5).map(sampleReference),
        })),
        note: 'Up to five latest stored response references, with buyer question and request mode, for each counted brand or competitor mention after all comparison scopes and retry deduplication. Mentions are not verified source citations; references contain no raw AI answers. Counts use all eligible observations, not only these samples.',
      };
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
            .map(([, text]) => redactEvidenceText(text)),
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
        .map(([, w]) => {
          const you_mentioned_by = [...w.engines].sort();
          const competitors_mentioned = [...w.competitors].sort();
          return {
            prompt: redactEvidenceText(w.prompt),
            you_mentioned_by,
            competitors_mentioned,
            you_cited_by: you_mentioned_by,
            competitors_cited: competitors_mentioned,
          };
        });
      const prompts_you_win = topPrompts(winsByPrompt);
      const prompts_brand_only = topPrompts(brandOnlyByPrompt);
      const prompts_co_mentioned = topPrompts(coMentionedByPrompt);

      const payload = {
        brand_id,
        days,
        mention_evidence_samples,
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
        "Page citations and ranked sources; look up one exact source domain past the cap. Lookup leaves citation pages and window counts unchanged. Includes run/response IDs for drilldown. No provider calls. Example: brand_id='acme'.",
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
        top_sources_limit: z.number().int().min(1).max(50).default(10)
          .describe('Ranked source domains, 1-50 (default 10); independent of citation page size.'),
        ranked_source_domain: z.string().trim().min(1).max(253).optional()
          .describe('Exact ranked domain lookup beyond top-50; does not filter citation pages or window counts.'),
        current_identity_only: z.boolean().default(false)
          .describe('Filter citations and source rankings to current-brand runs when the identity boundary is known.'),
        active_prompts_only: z.boolean().default(false)
          .describe('Filter citations and source rankings to currently active buyer questions without new provider scans.'),
        cursor: z.string().max(1600).optional()
          .describe('next_cursor; keep brand, days, engine(s), measurement_mode, ranked_source_domain, identity, prompts.'),
      },
      outputSchema: citationsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, days = 14, engine, engines, measurement_mode, limit = 50, top_sources_limit = 10, ranked_source_domain, current_identity_only = false,
      active_prompts_only = false, cursor }) => {
      const selectedEngines = [...new Set(engines ?? [])].sort();
      if (engine && selectedEngines.length) {
        throw new Error('Select either engine or engines, not both.');
      }
      const engineSelection = engine ?? (selectedEngines.length ? selectedEngines : undefined);
      const requestedEngines = engine ? [engine] : selectedEngines;
      const rankedSourceDomain = ranked_source_domain === undefined ? null : normalizeDomainInput(ranked_source_domain);
      if (ranked_source_domain !== undefined && rankedSourceDomain === null) {
        throw new Error('Invalid ranked source domain. Provide a valid domain-shaped hostname from ranked citations.');
      }
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
        active_prompts_only, promptRosterDigest, rankedSourceDomain,
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
      const totalMatchingRows = await deps.db.countCitationRows(brand_id, since, engineSelection, {
        until, minRunStartedAt, activePromptsOnly: active_prompts_only, measurementMode: measurement_mode,
      });
      const sourceResponses = await deps.db.getCitationSourceRows(
        brand_id, since, until, engineSelection, minRunStartedAt, active_prompts_only, measurement_mode,
      );
      const rankedSources = buildTopSources(sourceResponses, brand, identityBoundary);
      // Exact domain drilldown only changes the ranked summary; page/coverage
      // denominators still describe the entire selected observation window.
      const selectedRankedSources = rankedSourceDomain === null ? rankedSources
        : rankedSources.filter(({ domain }) => domain === rankedSourceDomain);
      const observationEvidence = new Map<string, {
        count: number;
        prompts: Set<string>;
        latestCapturedAt: number;
      }>();
      for (const response of sourceResponses) {
        const evidence = observationEvidence.get(response.engine);
        if (evidence) {
          evidence.count++;
          evidence.prompts.add(response.prompt_id);
          evidence.latestCapturedAt = Math.max(evidence.latestCapturedAt, response.captured_at);
        } else {
          observationEvidence.set(response.engine, {
            count: 1,
            prompts: new Set([response.prompt_id]),
            latestCapturedAt: response.captured_at,
          });
        }
      }
      const scopedEngineNames = requestedEngines.length
        ? [...requestedEngines].sort()
        : [...observationEvidence.keys()].sort();

      const citations = results.map((row) => {
        const engineHosts = parseStringArray(row.engine_citations_json);
        const brandUrl = pickBrandUrl(brand, engineHosts, row.raw_response);
        const citedUrl = brandUrl ? redactCitationUrlQuery(brandUrl.url) : null;
        return {
          id: citationId(row.response_id),
          run_id: row.run_id,
          response_id: row.response_id,
          engine: row.engine,
          prompt: redactEvidenceText(row.prompt),
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
          cited_url: citedUrl,
          url_redacted: brandUrl !== null && citedUrl !== brandUrl.url,
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
        observation_coverage: {
          per_engine: scopedEngineNames.map((engineName) => {
            const evidence = observationEvidence.get(engineName);
            return {
              engine: engineName,
              successful_observation_count: evidence?.count ?? 0,
              distinct_prompt_count: evidence?.prompts.size ?? 0,
              last_observed_at: evidence ? new Date(evidence.latestCapturedAt).toISOString() : null,
            };
          }),
          note: 'Latest successful stored observation per run and prompt in the selected window, before citation pagination. Distinct prompts count stored prompt IDs, not unique question texts; last_observed_at is response capture time, not proof of a fresh scan or current brand identity. Counts are not brand mentions, source citations, completed scans, or visibility scores. Zero for a requested engine means unmeasured here, not zero visibility.',
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
        total_matching_rows: totalMatchingRows,
        total_matching_rows_note: 'Full selected window before pagination: all successful brand mentions or source links, including historical retries. This is not a unique prompt count, total scanned prompts, or number of verified source citations.',
        has_more: hasMore,
        next_cursor: hasMore && results.length > 0
          ? encodeURIComponent(JSON.stringify({
              v: 1,
              brand_id,
              days,
              engine: engine ?? null,
              ...(selectedEngines.length ? { engines: selectedEngines } : {}),
              ...(measurement_mode ? { measurement_mode } : {}),
              ...(rankedSourceDomain ? { ranked_source_domain: rankedSourceDomain } : {}),
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
        top_sources_limit,
        total_source_domains: rankedSources.length,
        top_sources_truncated: selectedRankedSources.length > top_sources_limit,
        ranked_source_domain_filter: rankedSourceDomain,
        ranked_source_domain_match_found: rankedSourceDomain !== null && selectedRankedSources.length > 0,
        top_sources: selectedRankedSources.slice(0, top_sources_limit),
        citations,
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    toolName('get_observation_evidence'),
    {
      title: 'Inspect one stored AI observation',
      description:
        "Read a brand-owned stored response as a redacted excerpt. Optional competitor focus requires a recorded mention. No provider calls or verified citations. Example: brand_id='acme', run_id='run-1', response_id='response-1'.",
      inputSchema: {
        brand_id: z.string().min(1).max(128)
          .describe('Tracked brand ID that owns the originating run.'),
        run_id: z.string().min(1).max(128)
          .describe('Run ID from a stored evidence reference.'),
        response_id: z.string().min(1).max(128)
          .describe('Response ID from the same stored evidence reference.'),
        focus_competitor: z.string().trim().min(1).max(253).optional()
          .describe('Recorded competitor domain; prioritizes its mention in the redacted excerpt.'),
      },
      outputSchema: observationEvidenceOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ brand_id, run_id, response_id, focus_competitor }) => {
      const missing = 'Successful stored observation not found for this brand, run and response.';
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) throw new Error(missing);
      const run = await deps.db.getRunById(run_id);
      // A guessed run or response ID must not reveal another brand's observations.
      if (!run || run.brand_id !== brand_id) throw new Error(missing);
      const response = (await deps.db.getResponsesForRun(run.id)).find(
        (row) => row.run_id === run.id && row.id === response_id && row.status === 'ok',
      );
      if (!response) throw new Error(missing);
      const requestedCompetitor = focus_competitor?.toLowerCase() ?? null;
      // A guessed term cannot be used to explore arbitrary slices of a
      // stored response. Only competitors recorded for this observation qualify.
      if (requestedCompetitor && !response.competitors_mentioned.some(
        (domain) => domain.toLowerCase() === requestedCompetitor,
      )) throw new Error(missing);
      const activePromptIds = new Set(
        (await deps.db.getActivePrompts(brand_id)).map(({ id }) => id),
      );
      const providerSources = new Map<string, { url: string; url_redacted: boolean }>();
      let filteredProviderSourceUrls = 0;
      let deduplicatedProviderSourceUrls = 0;
      // Special-use hostnames are not publicly actionable AI source links.
      // Avoid exposing private network names in client-facing audit evidence.
      // Tor and alternative namespace names are not globally DNS-resolvable
      // sources either (RFC 7686 / RFC 9476).
      const nonPublicSuffixes = [
        '.local', '.localhost', '.internal', '.test', '.invalid', '.example',
        '.home.arpa', '.onion', '.alt',
      ];
      for (const rawUrl of response.engine_citations) {
        try {
          // Native provider links are evidence, not trusted instructions or
          // verified sources. Exclude malformed, local and credentialed URLs.
          if (/[\u0000-\u001f\u007f]/.test(rawUrl) || rawUrl !== rawUrl.trim()) {
            filteredProviderSourceUrls++;
            continue;
          }
          const parsed = new URL(rawUrl);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            filteredProviderSourceUrls++;
            continue;
          }
          const hostname = normalizeDomainInput(parsed.hostname);
          if (parsed.username || parsed.password || !hostname || hostname === 'home.arpa' ||
            nonPublicSuffixes.some((suffix) => hostname.endsWith(suffix))) {
            filteredProviderSourceUrls++;
            continue;
          }
          const safeUrl = redactCitationUrlQuery(rawUrl);
          if (!providerSources.has(safeUrl)) {
            providerSources.set(safeUrl, { url: safeUrl, url_redacted: safeUrl !== rawUrl });
          } else {
            deduplicatedProviderSourceUrls++;
          }
        } catch {
          // One invalid provider URL cannot hide other usable evidence.
          filteredProviderSourceUrls++;
        }
      }
      const providerSourceList = [...providerSources.values()];
      const identityBoundary = brand.identity_changed_at ?? null;
      const payload = {
        brand_id,
        run_id: run.id,
        response_id: response.id,
        engine: response.engine,
        prompt_id: response.prompt_id,
        prompt: redactEvidenceText(response.prompt_text),
        captured_at: Number.isFinite(response.captured_at) &&
          response.captured_at > 0 && Math.abs(response.captured_at) <= 8.64e15
          ? new Date(response.captured_at).toISOString() : null,
        status: 'ok' as const,
        measurement_mode: visibilityMeasurementMode(run.engine, run.mode),
        identity_scope: identityBoundary === null ? 'unknown_boundary' as const
          : run.started_at < identityBoundary ? 'historical_identity' as const
          : 'current_identity' as const,
        active_prompt: activePromptIds.has(response.prompt_id),
        brand_mentioned: response.brand_mentioned === 1,
        competitors_mentioned: [...new Set(response.competitors_mentioned)].sort(),
        response_excerpt: buildResponseExcerpt(response.raw_response, brand, requestedCompetitor ?? undefined),
        requested_competitor: requestedCompetitor,
        provider_source_count: providerSourceList.length,
        provider_source_urls_filtered_count: filteredProviderSourceUrls,
        provider_source_urls_deduplicated_count: deduplicatedProviderSourceUrls,
        provider_source_urls_truncated: providerSourceList.length > 5,
        provider_source_urls: providerSourceList.slice(0, 5),
        google_search_sampling: googleSearchSampling([run.engine]),
        evidence_note: 'This is a short credential-redacted excerpt of one stored successful response, not a full answer or an independently verified source citation. The original buyer question is credential-redacted without excerpt truncation. An optional recorded competitor focus is best effort; absence from the excerpt does not disprove a recorded mention. Provider-returned source URLs are not independently verified; access-bearing URL query and fragment fields are masked. provider_source_count counts accepted unique URLs, with filtered and deduplicated (after masking) counts reported separately; only the first five are shown. Review identity_scope, active_prompt and measurement_mode before quoting in an audit. No provider request occurred.',
      };
      return toolResult(payload);
    },
  );

  server.registerTool(
    toolName('get_content_gaps'),
    {
      title: 'Find AI visibility content gaps',
      description:
        "Prioritize stored competitor-winning prompts. engines and measurement_mode scope audit evidence. Provider-free unless ai_analysis=true opts into token-billed Claude. Example: brand_id='acme'.",
      inputSchema: {
        brand_id: z
          .string()
          .describe('Tracked brand ID to analyze.'),
        engines: z.array(engineSchema).optional()
          .describe('Only recommend from these engines; omit or pass [] to retain all-engine defaults.'),
        measurement_mode: z.enum(['model_only', 'search_requested']).optional()
          .describe('Select latest matching request-mode runs; omit for historical all-mode default.'),
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
    async ({ brand_id, engines, measurement_mode, max_recommendations, ai_analysis }) => {
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
            measurement_mode: 'model_only' | 'search_requested';
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
        // Claude/Gemini never request search, even during a live run. For
        // other engines, batch runs are model-only; query the matching run
        // rather than discarding an older matching cohort after latest lookup.
        if (measurement_mode === 'search_requested' &&
            (engine === 'claude' || engine === 'gemini')) continue;
        const runMode = !measurement_mode ? undefined :
          measurement_mode === 'search_requested' ? 'live' :
          engine === 'claude' || engine === 'gemini' ? undefined : 'batch';
        const run = await deps.db.getLatestCompletedRun(brand_id, engine, runMode);
        if (!run) continue;
        if (measurement_mode &&
            visibilityMeasurementMode(engine, run.mode ?? 'live') !== measurement_mode) continue;
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
        // Completion may lag the actual answers by days. Use successful
        // active-prompt capture times, not a late status update or a retired
        // prompt. Only legacy successes lacking capture times use the run date.
        const latestCaptureMs = [...latestOkByPrompt.values()].reduce<number | null>(
          (latest, row) => Number.isFinite(row.captured_at) && row.captured_at > 0 &&
            row.captured_at <= 8.64e15 && (latest === null || row.captured_at > latest)
            ? row.captured_at : latest,
          null,
        );
        const refreshedAtMs = latestOkByPrompt.size === 0 ? null :
          (latestCaptureMs ?? run.completed_at ?? run.started_at);
        perEngineCoverage.push({
          engine, run_id: run.id,
          refreshed_at: refreshedAtMs !== null && Number.isFinite(refreshedAtMs) &&
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
          const observationMode = visibilityMeasurementMode(engine, run.mode ?? 'live');
          const observation = {
            engine: r.engine,
            run_id: run.id,
            response_id: r.id,
            measurement_mode: observationMode,
            captured_at_ms: r.captured_at,
            competitors_mentioned: [...new Set(currentMentions)].sort(),
          };
          lossModeByEngine.set(engine, observationMode);
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
      // Keep evidence ordering and stored questions intact, but do not expose
      // embedded credentials in client reports or opt-in analyzer inputs.
      const safeLosingPrompts = losingPrompts.map((prompt) => ({
        ...prompt,
        prompt_text: redactEvidenceText(prompt.prompt_text),
      }));
      const losing_prompt_evidence = {
        note: 'These are stored response record references for observed competitor-only mentions in the current active prompt set, not independently verified source citations. Buyer questions are credential-redacted in this report. Each observation records its model-only or search-requested request mode; neither mode proves a citation. No raw model answers are included; inspect stored responses before quoting any evidence in a client audit.',
        prompts: safeLosingPrompts.map(({ prompt_id, prompt_text, observations }) => ({
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
        note: 'Counts are unique active prompts with a successful stored response in the selected engine/request-mode cohort after recorded identity changes, not verified citations or a confidence score. Per-engine refreshed_at is the latest successful active-prompt capture time (run completion/start only for legacy successes without capture time); null means no usable dated observations. It does not prove all prompts succeeded. unmeasured_engines include engines without an eligible selected-mode run, with stale identity or zero usable active-prompt responses; others may be unconfigured or unscanned. Refreshing incomplete engines may incur provider charges.',
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
        measurement_mode_filter: measurement_mode ?? null,
        search_requested_engines: searchRequestedEngines,
        model_only_engines: modelOnlyEngines,
        mixed_modes: searchRequestedEngines.length > 0 && modelOnlyEngines.length > 0,
        note: measurement_mode
          ? 'Only latest eligible stored runs for the selected request mode contribute to losses, coverage and recommendations. Engines without eligible data are unmeasured, not observed zeros. Search-requested does not prove citations; no provider refresh occurs.'
          : 'Engines contributing competitor-only losses are grouped by request path. Search-requested does not prove a source citation was returned; model-only observations are not live AI-search evidence. Review stored answers before using recommendations in a client audit.',
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

      let recommendations = buildFallbackRecommendations(safeLosingPrompts, max_recommendations);
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
              safeLosingPrompts,
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
        preview_only: z.boolean().default(false)
          .describe('Preview configured prompt-engine pairs without provider calls; not a billing quote.'),
      },
      outputSchema: refreshOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ brand_id, engines, preview_only = false }) => {
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const prompts = await deps.db.getActivePrompts(brand_id);
      if (prompts.length === 0 && !preview_only) {
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
      if (filtered.length === 0 && !preview_only) {
        if (requested && requested.length > 0) {
          throw new Error(
            `Requested engines are not configured: ${uniqueEngineNames(requested).join(', ')}. Configure the matching provider API key (and SERPAPI_AI_MODE_ENABLED=true for Google AI Mode), or omit engines to refresh every configured engine.`,
          );
        }
        throw new Error(
          'No engines available. Set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, XAI_API_KEY, SERPAPI_API_KEY. Google AI Mode additionally requires SERPAPI_AI_MODE_ENABLED=true.',
        );
      }
      if (preview_only) {
        const readinessWarnings: string[] = [];
        const readyToRefresh = prompts.length > 0 && filtered.length > 0;
        if (prompts.length === 0) {
          readinessWarnings.push('No active prompts. Add or activate buyer-intent prompts before scanning.');
        }
        if (filtered.length === 0) {
          readinessWarnings.push(requested
            ? `No requested provider engines configured (${uniqueEngineNames(requested).join(', ')}). Configure their API keys or select available engines.`
            : 'No provider engines configured. Set at least one supported provider API key before scanning.');
        }
        if (filtered.length > 0 && skippedUnconfigured.length > 0) {
          readinessWarnings.push(`Requested engines without configuration will be skipped: ${skippedUnconfigured.join(', ')}. Configure their API keys to scan the complete requested scope.`);
        }
        return toolResult({
          brand_id: brand.id,
          message: !readyToRefresh
            ? `Preview only: scan not ready; no provider requests started. ${readinessWarnings.join(' ')}`
            : skippedUnconfigured.length > 0
              ? `Preview only: partial engine scope; no provider requests started. ${readinessWarnings.join(' ')} Ready to scan configured engines only; review provider charges before proceeding.`
            : 'Preview only: no provider requests started. Run refresh_brand without preview_only only after reviewing the active prompts and provider charges.',
          run_ids: {},
          failed_engines: [],
          skipped_unconfigured_engines: skippedUnconfigured,
          estimated_completion_seconds: 0,
          preview_only: true,
          planned_engines: filtered,
          active_prompt_count: prompts.length,
          planned_prompt_engine_pairs: prompts.length * filtered.length,
          ready_to_refresh: readyToRefresh,
          readiness_warnings: readinessWarnings,
          cost_note: 'Logical prompt-engine pairs are not a billing estimate or total cost. Actual API requests, retries, token use and provider charges can differ.',
        });
      }
      const { run_ids, engines: kicked, failed_engines = [] } = await deps.runEnginesInline(
        brand,
        prompts,
        filtered,
      );
      const alreadyRunning = Object.keys(run_ids).length - kicked.length;
      const completedCount = kicked.length - failed_engines.length;
      const payload = {
        brand_id: brand.id,
        message: (failed_engines.length > 0
          ? `Refresh partially completed for ${completedCount} engine${completedCount === 1 ? '' : 's'}; failed: ${failed_engines.join(', ')} (check stored run status before retrying; provider calls may incur charges)`
          : `Refresh ${refreshIsAsync ? 'started' : 'completed'} for ${kicked.length} engine${kicked.length === 1 ? '' : 's'}`) +
          (alreadyRunning > 0
            ? `; ${alreadyRunning} engine${alreadyRunning === 1 ? '' : 's'} already in progress (existing run IDs reused)`
            : '') +
          (skippedUnconfigured.length > 0 ? `; skipped unconfigured: ${skippedUnconfigured.join(', ')}` : ''),
        run_ids,
        failed_engines,
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
  const previewNextStep = (brandId: string) =>
    `Call refresh_brand with brand_id '${brandId}', preview_only=true to review active prompts and configured engines without provider requests. Run without preview_only only after reviewing the scope and potential provider charges.`;
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
              ? `Tracked with ${result.prompts_inserted} provider-free category-anchored starter prompts. Review list_prompts and customize with set_prompts for representative buyer questions before interpreting scores. ${previewNextStep(result.brand_id)} Paid generate_prompts remains optional.`
              : `Tracked with ${result.prompts_inserted} limited starter prompts. No category was supplied, so these prompts use your brand name and can bias visibility scores. Set a category with update_brand and supply independent category prompts with set_prompts before a real scan. ${previewNextStep(result.brand_id)}`
            : `${previewNextStep(result.brand_id)} Then check_visibility for the results after a real scan.`;
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
            ? 'Category changed, but active prompts and historical runs were preserved. Review list_prompts and use set_prompts to replace outdated buyer-intent prompts before a new scan. generate_prompts uses a paid API and is optional.'
            : 'Active prompts and historical runs were preserved.',
          previewNextStep(brand_id),
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
        next_steps: previewNextStep(brand_id),
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
        next_steps: previewNextStep(brand_id),
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
  // Historical provider evidence may predate source-host filtering at ingest.
  // Exclude private/internal, special-use and invalid/test hostnames from audit rankings.
  const nonPublicSuffixes = ['.local', '.localhost', '.internal', '.test', '.invalid', '.home.arpa', '.onion', '.alt'];
  const engineObservationCounts = new Map<string, number>();
  for (const response of responses) {
    engineObservationCounts.set(response.engine, (engineObservationCounts.get(response.engine) ?? 0) + 1);
  }
  const sources = new Map<
    string,
    {
      citation_count: number;
      engineCitationCounts: Map<string, number>;
      enginePrompts: Map<string, Set<string>>;
      engineLastCapturedAt: Map<string, number>;
      engineSamples: Map<string, { url: string; capturedAt: number; responseId: string; runId: string }>;
      pathResponseCounts: Map<string, number>;
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
    const pathsForResponse = new Map<string, Set<string>>();
    const identityScope = identityBoundary === null
      ? null : citationIdentityScope(response.run_started_at, identityBoundary);
    for (const rawUrl of response.engine_citations) {
      try {
        // WHATWG URL silently drops tabs/newlines and trims outer whitespace.
        // Historical malformed provider links are not trustworthy audit evidence.
        if (/[\u0000-\u001f\u007f]/.test(rawUrl) || rawUrl !== rawUrl.trim()) continue;
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
        if (parsed.username || parsed.password) continue;
        // A provider URL can name localhost, an IP or an invalid DNS host.
        // Only rank domain-shaped sources using the same host rules as brands.
        const domain = normalizeDomainInput(parsed.hostname);
        if (!domain) continue;
        if (domain === 'home.arpa' || nonPublicSuffixes.some((suffix) => domain.endsWith(suffix))) continue;
        if (!domainsForResponse.has(domain)) domainsForResponse.set(domain, rawUrl);
        const citedPaths = pathsForResponse.get(domain) ?? new Set<string>();
        citedPaths.add(parsed.pathname);
        pathsForResponse.set(domain, citedPaths);
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
        existing.engineCitationCounts.set(response.engine, (existing.engineCitationCounts.get(response.engine) ?? 0) + 1);
        const enginePrompts = existing.enginePrompts.get(response.engine) ?? new Set<string>();
        enginePrompts.add(response.prompt_id);
        existing.enginePrompts.set(response.engine, enginePrompts);
        existing.engineLastCapturedAt.set(response.engine, Math.max(
          existing.engineLastCapturedAt.get(response.engine) ?? -Infinity, response.captured_at,
        ));
        const engineSample = existing.engineSamples.get(response.engine);
        if (!engineSample || response.captured_at > engineSample.capturedAt ||
          (response.captured_at === engineSample.capturedAt && response.id < engineSample.responseId)) {
          existing.engineSamples.set(response.engine, {
            url: sampleUrl, capturedAt: response.captured_at, responseId: response.id, runId: response.run_id,
          });
        }
        for (const path of pathsForResponse.get(domain) ?? []) {
          existing.pathResponseCounts.set(path, (existing.pathResponseCounts.get(path) ?? 0) + 1);
        }
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
          engineCitationCounts: new Map([[response.engine, 1]]),
          enginePrompts: new Map([[response.engine, new Set([response.prompt_id])]]),
          engineLastCapturedAt: new Map([[response.engine, response.captured_at]]),
          engineSamples: new Map([[response.engine, {
            url: sampleUrl, capturedAt: response.captured_at, responseId: response.id, runId: response.run_id,
          }]]),
          pathResponseCounts: new Map([...(pathsForResponse.get(domain) ?? [])]
            .map((path): [string, number] => [path, 1])),
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
    .map(([domain, source]) => {
      const sampleUrl = redactCitationUrlQuery(source.sample_url);
      return {
        domain,
        citation_count: source.citation_count,
        per_engine_citation_count: Object.fromEntries([...source.engineCitationCounts].sort(([a], [b]) => a.localeCompare(b))),
        per_engine_source_observation_percent: Object.fromEntries(
          [...source.engineCitationCounts].sort(([a], [b]) => a.localeCompare(b))
            .map(([engine, count]) => [engine, Math.round(1000 * count / (engineObservationCounts.get(engine) ?? 1)) / 10]),
        ),
        per_engine_distinct_prompt_count: Object.fromEntries(
          [...source.enginePrompts].sort(([a], [b]) => a.localeCompare(b)).map(([engine, prompts]) => [engine, prompts.size]),
        ),
        per_engine_last_observed_at: Object.fromEntries(
          [...source.engineLastCapturedAt].sort(([a], [b]) => a.localeCompare(b))
            .map(([engine, capturedAt]) => [engine, new Date(capturedAt).toISOString()]),
        ),
        per_engine_examples: Object.fromEntries(
          [...source.engineSamples].sort(([a], [b]) => a.localeCompare(b)).map(([engine, sample]) => {
            const safeUrl = redactCitationUrlQuery(sample.url);
            return [engine, {
              sample_url: safeUrl, url_redacted: safeUrl !== sample.url,
              run_id: sample.runId, response_id: sample.responseId,
            }];
          }),
        ),
        distinct_cited_path_count: source.pathResponseCounts.size,
        top_cited_paths: [...source.pathResponseCounts.entries()]
          .sort(([pathA, countA], [pathB, countB]) => countB - countA || pathA.localeCompare(pathB))
          .slice(0, 5).map(([path, response_count]) => ({ path, response_count })),
        prompt_count: source.prompts.size,
        last_observed_at: new Date(source.sample_captured_at).toISOString(),
        engines: [...source.engines].sort(),
        measurement_modes: [...source.measurement_modes].sort(),
        ...(identityBoundary !== null ? { identity_scopes: [...source.identity_scopes].sort() } : {}),
        sample_url: sampleUrl,
        url_redacted: sampleUrl !== source.sample_url,
        is_brand_domain: hostMatchesDomain(domain, brand.domain),
      };
    })
    .sort(
      (a, b) =>
        b.citation_count - a.citation_count ||
        b.prompt_count - a.prompt_count ||
        a.domain.localeCompare(b.domain),
    );
}

// Source URLs can contain access-bearing query or fragment values without URL
// userinfo. Redact named credentials at the output boundary while preserving
// the original URL spelling and nonsecret source context.
function redactCitationUrlQuery(rawUrl: string): string {
  const fragmentStart = rawUrl.indexOf('#');
  const address = fragmentStart === -1 ? rawUrl : rawUrl.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? null : rawUrl.slice(fragmentStart + 1);
  const queryStart = address.indexOf('?');
  const secretNames = new Set([
    'apikey', 'key', 'token', 'accesstoken', 'refreshtoken', 'authtoken',
    'idtoken', 'clientsecret', 'apisecret', 'secret', 'password', 'passwd',
    'signature', 'authorization', 'auth', 'sig',
    // Cloud presigned URLs use bearer capabilities under provider-specific keys.
    'awsaccesskeyid', 'xamzcredential', 'xamzsignature', 'xamzsecuritytoken',
    'xgoogcredential', 'xgoogsignature', 'xgoogsecuritytoken',
  ]);
  const redactParameters = (parameters: string): string => parameters.split(/([&;])/).map((piece) => {
    const equals = piece.indexOf('=');
    if (equals < 0) return piece;
    let name = piece.slice(0, equals);
    try {
      name = decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      // An invalid encoded name is not interpreted as a credential key.
    }
    // Array and nested form keys can carry credentials too: token[] or
    // auth[access_token], including percent-encoded bracket spellings.
    const keyParts = name.toLowerCase().split(/[\[\]]+/)
      .map((part) => part.replace(/[-_.\s]/g, ''));
    return keyParts.some((part) => secretNames.has(part))
      ? `${piece.slice(0, equals)}=[REDACTED]` : piece;
  }).join('');
  const safeAddress = queryStart === -1 ? address
    : `${address.slice(0, queryStart + 1)}${redactParameters(address.slice(queryStart + 1))}`;
  if (fragment === null) return safeAddress;
  // OAuth fragments commonly encode key/value pairs directly; hash routers
  // also place their own query string after a route or anchor prefix.
  const hashQueryStart = fragment.indexOf('?');
  const safeFragment = hashQueryStart === -1 ? redactParameters(fragment)
    : `${redactParameters(fragment.slice(0, hashQueryStart))}?${redactParameters(fragment.slice(hashQueryStart + 1))}`;
  return `${safeAddress}#${safeFragment}`;
}

function redactEvidenceText(text: string): string {
  // Stored text can carry credentials even when a URL is not valid citation
  // evidence. Apply the same output-only redaction to excerpts and questions.
  // Closing parentheses and square brackets can occur in URL paths before
  // token-bearing query or fragment values. Keep scanning to redact them.
  const urlSafeText = text.replace(/https?:\/\/[^\s<>"'`]+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl.replace(/[.,;!]+$/, ''));
      return parsed.username || parsed.password
        ? '[credential-bearing URL omitted]' : redactCitationUrlQuery(rawUrl);
    } catch {
      // Malformed provider URLs may still contain access-bearing query or
      // userinfo text. They cannot establish valid citation evidence.
      return '[unparseable URL omitted]';
    }
  });
  // HTTP header folding makes whitespace-prefixed continuation lines part of
  // the preceding credential, including proxy credentials. Mask them together
  // before line-based redaction.
  const foldedHeaderSafeText = urlSafeText.replace(
    /^([ \t]*(?:(?:Proxy-)?Authorization|Set-Cookie|Cookie|X-(?:[A-Za-z0-9-]+-)?(?:Token|Api-Key|Auth-Key|Secret))[ \t]*:[ \t]*)([^\r\n]*)(?:\r?\n[ \t]+[^\r\n]*)+/gim,
    (_match, header: string, firstValue: string) => {
      const scheme = /^([A-Za-z][A-Za-z0-9+.-]*[ \t]+)/.exec(firstValue);
      return /Authorization[ \t]*:[ \t]*$/i.test(header) && scheme
        ? `${header}${scheme[1]}[REDACTED]`
        : `${header}[REDACTED]`;
    },
  );
  // Provider prose can contain standalone credential assignments and auth
  // headers, not just URLs. Mask their values before selecting an excerpt;
  // raw stored observations remain unchanged for forensic provenance.
  return foldedHeaderSafeText
    // Cookie and custom token/key headers can expose session credentials;
    // mask full values, including previously unknown X-*-Token names.
    .replace(/\b((?:Set-Cookie|Cookie|X-(?:[A-Za-z0-9-]+-)?(?:Token|Api-Key|Auth-Key|Secret))[ \t]*:[ \t]*)[^\r\n]*/gi, '$1[REDACTED]')
    // Digest and SigV4 credentials consist of multiple parameters. Redacting
    // just the first token would expose the nonce, response or signature.
    .replace(/\b(Authorization[ \t]*:[ \t]*(?:Digest|AWS4-HMAC-SHA256)[ \t]+)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/\b(Authorization\s*:\s*(?:Bearer|Basic|Token|ApiKey|Api-Key)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    // Unknown authorization schemes can also carry multi-parameter secrets;
    // preserve the scheme label but mask the entire remaining header line.
    .replace(/\b(Authorization[ \t]*:[ \t]*)(?!(?:Digest|AWS4-HMAC-SHA256|Bearer|Basic|Token|ApiKey|Api-Key)[ \t]+)([A-Za-z][A-Za-z0-9+.-]*[ \t]+)[^\r\n]*/gi, '$1$2[REDACTED]')
    .replace(/\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;]+)/gi, '$1[REDACTED]');
}

export function buildResponseExcerpt(text: string, brand: Brand, focusCompetitor?: string): string {
  if (!text) return '';
  if (text === '[NO_AI_OVERVIEW]') return text;
  const safeText = redactEvidenceText(text);
  const focusIdx = focusCompetitor
    ? findTermSetMatchIndex(safeText, { domain: focusCompetitor })
    : -1;
  const idx = focusIdx !== -1 ? focusIdx : findTermSetMatchIndex(safeText, {
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
      // WHATWG URL normalizes malformed stored links; do not present them as direct citations.
      if (/[\u0000-\u001f\u007f]/.test(rawUrl) || rawUrl !== rawUrl.trim()) continue;
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
