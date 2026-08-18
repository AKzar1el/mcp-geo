// Runtime-agnostic database contract shared by the Cloudflare Worker
// (D1, src/db/d1.ts) and the local stdio CLI (better-sqlite3,
// src/db/sqlite.ts). All timestamps are unix-ms (Date.now()). JSON
// columns are parsed at the boundary so callers never deal with raw
// TEXT. This file must stay free of Workers and Node-specific imports.

export interface Brand {
  id: string;
  user_id: string;
  domain: string;
  name: string;
  category: string | null;
  competitors: string[];
  // Extra terms that always count as a brand mention (word-boundary
  // matched), e.g. product names or common abbreviations.
  aliases: string[];
  // Terms suppressed from the bare-word match on the brand name and
  // domain root — for homograph brands ("Monday" the brand vs "monday"
  // the weekday). The full domain and aliases still match.
  exclude_terms: string[];
  refresh_frequency: string;
  created_at: number;
  updated_at: number;
}

export interface Prompt {
  id: string;
  brand_id: string;
  text: string;
  intent_stage: string | null;
  shape: string | null;
  active: number;
  created_at: number;
}

export interface Run {
  id: string;
  brand_id: string;
  engine: string;
  mode: 'live' | 'batch';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  batch_id: string | null;
  prompts_total: number;
  prompts_completed: number;
  cost_eur_estimate: number | null;
  error: string | null;
  started_at: number;
  completed_at: number | null;
}

export type ResponseStatus = 'ok' | 'failed' | 'skipped';

export interface PromptResponse {
  id: string;
  run_id: string;
  prompt_id: string;
  prompt_text: string;
  engine: string;
  raw_response: string;
  brand_mentioned: number;
  brand_cited_with_link: number;
  cited_urls: string[];
  competitors_mentioned: string[];
  engine_citations: string[];
  status: ResponseStatus;
  error_message: string | null;
  captured_at: number;
}

export interface CachedResponse {
  prompt_hash: string;
  engine: string;
  model: string;
  raw_response: string;
  captured_at: number;
  expires_at: number;
}

export interface InsertPromptResponseInput {
  run_id: string;
  prompt_id: string;
  engine: string;
  raw_response: string;
  brand_mentioned: number;
  brand_cited_with_link: number;
  cited_urls: string[];
  competitors_mentioned: string[];
  engine_citations?: string[];
  status: ResponseStatus;
  error_message?: string | null;
}

// Per-prompt result produced by an engine's runLive. Collected into an
// array and flushed in a single batched write at the end of the run —
// see Db.persistEngineRun.
export interface EnginePromptResult {
  prompt_id: string;
  raw_response: string;
  brand_mentioned: number;
  brand_cited_with_link: number;
  cited_urls: string[];
  competitors_mentioned: string[];
  engine_citations?: string[];
  status: ResponseStatus;
  error_message?: string | null;
  cache_to_put?: { prompt_hash: string; raw_response: string };
}

export interface NewPromptInput {
  text: string;
  intent_stage: string | null;
  shape: string | null;
}

// Input for Db.createBrand. competitors/aliases/exclude_terms are
// serialized to their *_json columns at the adapter boundary, like
// everywhere else.
export interface CreateBrandInput {
  id: string;
  user_id: string;
  domain: string;
  name: string;
  category: string | null;
  competitors: string[];
  aliases: string[];
  exclude_terms: string[];
  refresh_frequency: string;
}

// Row shape behind the list_brands tool: every brand plus how many
// prompts are currently active for it.
export interface BrandSummary extends Brand {
  active_prompts: number;
}

export type UpdateRunFields = Partial<
  Pick<
    Run,
    | 'status'
    | 'batch_id'
    | 'prompts_completed'
    | 'cost_eur_estimate'
    | 'error'
    | 'completed_at'
  >
>;

// Row shape behind the get_visibility_history tool: one row per run
// that produced status='ok' prompt_responses, with COUNT/SUM aggregates
// over those rows. completed_at is COALESCE(completed_at, started_at)
// so partially-finished runs (stuck at in_progress) still count toward
// history; runs with zero ok rows are excluded entirely rather than
// charting as a fake score of 0.
export interface VisibilityHistoryRow {
  run_id: string;
  engine: string;
  completed_at: number;
  total: number | null;
  hits: number | null;
}

// Row shape behind the get_citations tool: every status='ok',
// brand_mentioned=1 response joined to its run + prompt, newest first.
export interface CitationRow {
  engine: string;
  prompt: string;
  raw_response: string;
  brand_mentioned: number;
  brand_cited_with_link: number;
  cited_urls_json: string | null;
  engine_citations_json: string | null;
  captured_at: number;
  run_id: string;
  prompt_id: string;
}

// Every query helper the Worker and CLI need. Mirrors the helper
// functions that previously lived in src/db.ts, plus the two raw
// queries the visibility tools used to issue inline (visibility
// history, citations).
export interface Db {
  getBrand(brandId: string): Promise<Brand | null>;
  getActivePrompts(brandId: string): Promise<Prompt[]>;
  // Batch output custom_ids reference submitted prompt rows, which may have
  // been soft-deactivated by later prompt regeneration.
  getPromptsByIds(promptIds: string[]): Promise<Prompt[]>;
  // Seeding (core/seed.ts): INSERT OR IGNORE semantics on both — a
  // pre-existing user/brand row is left untouched, never clobbered.
  upsertUser(id: string, email: string): Promise<void>;
  createBrand(input: CreateBrandInput): Promise<void>;
  listBrands(): Promise<BrandSummary[]>;
  createRun(
    brand: Brand,
    engine: string,
    mode: 'live' | 'batch',
    promptsTotal: number,
  ): Promise<Run>;
  updateRun(runId: string, fields: UpdateRunFields): Promise<void>;
  getLatestRun(brandId: string, engine: string): Promise<Run | null>;
  // "Latest run that produced any usable data for this (brand, engine)"
  // — anchors on EXISTS(ok rows), NOT run.status='completed', so
  // partially-finished runs still surface their data.
  getLatestCompletedRun(brandId: string, engine: string): Promise<Run | null>;
  getRunById(runId: string): Promise<Run | null>;
  getBrandsDueForRefresh(): Promise<Brand[]>;
  insertPromptResponse(input: InsertPromptResponseInput): Promise<void>;
  // Idempotency for re-running an engine against an existing run row:
  // wipe any prompt_responses already written for that run first.
  deleteResponsesForRun(runId: string): Promise<void>;
  // One batched write covering every prompt's row, every cache entry to
  // back-fill, and the final run status.
  persistEngineRun(
    runId: string,
    engine: string,
    model: string,
    cacheTtlSeconds: number,
    results: EnginePromptResult[],
  ): Promise<void>;
  // Only returns status='ok' rows — failed/skipped rows must never
  // reach scoring.
  getResponsesForRun(runId: string): Promise<PromptResponse[]>;
  replacePrompts(brandId: string, prompts: NewPromptInput[]): Promise<number>;
  cacheGet(
    promptHash: string,
    engine: string,
    model: string,
  ): Promise<CachedResponse | null>;
  bulkCacheGet(
    promptHashes: string[],
    engine: string,
    model: string,
  ): Promise<Map<string, string>>;
  cachePut(
    promptHash: string,
    engine: string,
    model: string,
    rawResponse: string,
    ttlSeconds: number,
  ): Promise<void>;
  getVisibilityHistoryRows(
    brandId: string,
    since: number,
  ): Promise<VisibilityHistoryRow[]>;
  getCitationRows(
    brandId: string,
    since: number,
    engine?: string,
  ): Promise<CitationRow[]>;
}
