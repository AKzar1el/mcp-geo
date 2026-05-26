// Thin D1 helpers over env.DIGESTSEO_DB.
// All timestamps are unix-ms (Date.now()). JSON columns are parsed at the
// boundary so callers never deal with raw TEXT.

export interface DbEnv {
  DIGESTSEO_DB: D1Database;
}

export interface Brand {
  id: string;
  user_id: string;
  domain: string;
  name: string;
  category: string | null;
  competitors: string[];
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

interface BrandRow {
  id: string;
  user_id: string;
  domain: string;
  name: string;
  category: string | null;
  competitors_json: string | null;
  refresh_frequency: string;
  created_at: number;
  updated_at: number;
}

function rowToBrand(row: BrandRow): Brand {
  let competitors: string[] = [];
  if (row.competitors_json) {
    try {
      const parsed = JSON.parse(row.competitors_json);
      if (Array.isArray(parsed)) {
        competitors = parsed.filter((c): c is string => typeof c === 'string');
      }
    } catch {
      // malformed JSON — treat as no competitors rather than crashing
    }
  }
  return {
    id: row.id,
    user_id: row.user_id,
    domain: row.domain,
    name: row.name,
    category: row.category,
    competitors,
    refresh_frequency: row.refresh_frequency,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getBrand(
  env: DbEnv,
  brandId: string,
): Promise<Brand | null> {
  const row = await env.DIGESTSEO_DB.prepare(
    'SELECT id, user_id, domain, name, category, competitors_json, refresh_frequency, created_at, updated_at FROM brands WHERE id = ?',
  )
    .bind(brandId)
    .first<BrandRow>();
  if (!row) return null;
  return rowToBrand(row);
}

export async function getActivePrompts(
  env: DbEnv,
  brandId: string,
): Promise<Prompt[]> {
  const { results } = await env.DIGESTSEO_DB.prepare(
    'SELECT id, brand_id, text, intent_stage, shape, active, created_at FROM prompts WHERE brand_id = ? AND active = 1 ORDER BY created_at ASC',
  )
    .bind(brandId)
    .all<Prompt>();
  return results ?? [];
}

function randomId(): string {
  return crypto.randomUUID();
}

export async function createRun(
  env: DbEnv,
  brand: Brand,
  engine: string,
  mode: 'live' | 'batch',
  promptsTotal: number,
): Promise<Run> {
  const now = Date.now();
  const run: Run = {
    id: randomId(),
    brand_id: brand.id,
    engine,
    mode,
    status: 'in_progress',
    batch_id: null,
    prompts_total: promptsTotal,
    prompts_completed: 0,
    cost_eur_estimate: null,
    error: null,
    started_at: now,
    completed_at: null,
  };
  await env.DIGESTSEO_DB.prepare(
    `INSERT INTO runs
       (id, brand_id, engine, mode, status, batch_id, prompts_total,
        prompts_completed, cost_eur_estimate, error, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, NULL)`,
  )
    .bind(
      run.id,
      run.brand_id,
      run.engine,
      run.mode,
      run.status,
      run.batch_id,
      run.prompts_total,
      run.started_at,
    )
    .run();
  return run;
}

export async function updateRun(
  env: DbEnv,
  runId: string,
  fields: Partial<
    Pick<
      Run,
      | 'status'
      | 'batch_id'
      | 'prompts_completed'
      | 'cost_eur_estimate'
      | 'error'
      | 'completed_at'
    >
  >,
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    setClauses.push(`${key} = ?`);
    values.push(value);
  }
  if (setClauses.length === 0) return;
  values.push(runId);
  await env.DIGESTSEO_DB.prepare(
    `UPDATE runs SET ${setClauses.join(', ')} WHERE id = ?`,
  )
    .bind(...values)
    .run();
}

export async function getLatestRun(
  env: DbEnv,
  brandId: string,
  engine: string,
): Promise<Run | null> {
  const row = await env.DIGESTSEO_DB.prepare(
    `SELECT id, brand_id, engine, mode, status, batch_id, prompts_total,
            prompts_completed, cost_eur_estimate, error, started_at, completed_at
       FROM runs
      WHERE brand_id = ? AND engine = ?
      ORDER BY started_at DESC
      LIMIT 1`,
  )
    .bind(brandId, engine)
    .first<Run>();
  return row ?? null;
}

// "Latest run that produced any usable data for this (brand, engine)" —
// NOT "latest run with status='completed'". A subrequest-cap or wall-time
// abort can leave the runs row stuck at 'in_progress' even though some
// prompt_responses rows landed with status='ok'. Anchoring on EXISTS(ok
// rows) instead of run.status keeps the visibility tools honest about
// partial data and survives any future incident that interrupts a run.
export async function getLatestCompletedRun(
  env: DbEnv,
  brandId: string,
  engine: string,
): Promise<Run | null> {
  const row = await env.DIGESTSEO_DB.prepare(
    `SELECT r.id, r.brand_id, r.engine, r.mode, r.status, r.batch_id,
            r.prompts_total, r.prompts_completed, r.cost_eur_estimate,
            r.error, r.started_at, r.completed_at
       FROM runs r
      WHERE r.brand_id = ? AND r.engine = ?
        AND EXISTS (
          SELECT 1 FROM prompt_responses pr
           WHERE pr.run_id = r.id AND pr.status = 'ok'
        )
      ORDER BY COALESCE(r.completed_at, r.started_at) DESC
      LIMIT 1`,
  )
    .bind(brandId, engine)
    .first<Run>();
  return row ?? null;
}

export async function getRunById(
  env: DbEnv,
  runId: string,
): Promise<Run | null> {
  const row = await env.DIGESTSEO_DB.prepare(
    `SELECT id, brand_id, engine, mode, status, batch_id, prompts_total,
            prompts_completed, cost_eur_estimate, error, started_at, completed_at
       FROM runs
      WHERE id = ?`,
  )
    .bind(runId)
    .first<Run>();
  return row ?? null;
}

// Day 5: cron-driven refresh selection. A brand is due if:
//   - it has no completed run yet (first-time), OR
//   - its latest completed run is older than the cadence implied by
//     refresh_frequency ('weekly' → 7d, 'daily' → 1d).
// Brands with any other refresh_frequency value (e.g. 'monthly' if we
// add it later) won't be picked up by the current HAVING clause and
// need their own branch — fine for v1.
export async function getBrandsDueForRefresh(
  env: DbEnv,
): Promise<Brand[]> {
  const now = Date.now();
  const weeklyCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const dailyCutoff = now - 24 * 60 * 60 * 1000;
  const { results } = await env.DIGESTSEO_DB.prepare(
    `SELECT b.id, b.user_id, b.domain, b.name, b.category, b.competitors_json,
            b.refresh_frequency, b.created_at, b.updated_at,
            MAX(r.completed_at) AS last_run
       FROM brands b
       LEFT JOIN runs r
         ON r.brand_id = b.id AND r.status = 'completed'
      GROUP BY b.id
     HAVING last_run IS NULL
        OR (b.refresh_frequency = 'weekly' AND last_run < ?)
        OR (b.refresh_frequency = 'daily'  AND last_run < ?)`,
  )
    .bind(weeklyCutoff, dailyCutoff)
    .all<BrandRow & { last_run: number | null }>();
  return (results ?? []).map(rowToBrand);
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

export async function insertPromptResponse(
  env: DbEnv,
  input: InsertPromptResponseInput,
): Promise<void> {
  await env.DIGESTSEO_DB.prepare(
    `INSERT INTO prompt_responses
       (id, run_id, prompt_id, engine, raw_response, brand_mentioned,
        brand_cited_with_link, cited_urls_json, competitors_mentioned_json,
        engine_citations_json, status, error_message, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      randomId(),
      input.run_id,
      input.prompt_id,
      input.engine,
      input.raw_response,
      input.brand_mentioned,
      input.brand_cited_with_link,
      JSON.stringify(input.cited_urls),
      JSON.stringify(input.competitors_mentioned),
      input.engine_citations && input.engine_citations.length > 0
        ? JSON.stringify(input.engine_citations)
        : null,
      input.status,
      input.error_message ?? null,
      Date.now(),
    )
    .run();
}

// Idempotency for /admin/run-engine: before re-running an engine
// against an existing run row, wipe any prompt_responses already
// written for that run. Same run_id is reserved per (run, engine),
// so this can't clobber other engines.
export async function deleteResponsesForRun(
  env: DbEnv,
  runId: string,
): Promise<void> {
  await env.DIGESTSEO_DB.prepare(
    'DELETE FROM prompt_responses WHERE run_id = ?',
  )
    .bind(runId)
    .run();
}

// Per-prompt result produced by an engine's runLive. Collected into an
// array and flushed in a single D1.batch() at the end of the run, so
// 20 prompts cost 1 subrequest of writes instead of 40+. The bulk
// pattern is required for the per-engine fan-out to fit inside the
// Workers free-plan 50-subrequest cap.
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

// One D1 subrequest that writes every prompt's row, every cache entry
// to back-fill, and the final run status. Replaces the per-prompt
// insertPromptResponse + cachePut + per-chunk updateRun pattern that
// blew the 50-subrequest cap.
export async function persistEngineRun(
  env: DbEnv,
  runId: string,
  engine: string,
  model: string,
  cacheTtlSeconds: number,
  results: EnginePromptResult[],
): Promise<void> {
  const now = Date.now();
  const cacheExpiresAt = now + cacheTtlSeconds * 1000;
  const stmts: D1PreparedStatement[] = [];
  for (const r of results) {
    stmts.push(
      env.DIGESTSEO_DB.prepare(
        `INSERT INTO prompt_responses
           (id, run_id, prompt_id, engine, raw_response, brand_mentioned,
            brand_cited_with_link, cited_urls_json, competitors_mentioned_json,
            engine_citations_json, status, error_message, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        randomId(),
        runId,
        r.prompt_id,
        engine,
        r.raw_response,
        r.brand_mentioned,
        r.brand_cited_with_link,
        JSON.stringify(r.cited_urls),
        JSON.stringify(r.competitors_mentioned),
        r.engine_citations && r.engine_citations.length > 0
          ? JSON.stringify(r.engine_citations)
          : null,
        r.status,
        r.error_message ?? null,
        now,
      ),
    );
    if (r.cache_to_put) {
      stmts.push(
        env.DIGESTSEO_DB.prepare(
          `INSERT INTO shared_prompt_cache
             (prompt_hash, engine, model, raw_response, captured_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(prompt_hash, engine, model)
           DO UPDATE SET raw_response = excluded.raw_response,
                         captured_at = excluded.captured_at,
                         expires_at = excluded.expires_at`,
        ).bind(
          r.cache_to_put.prompt_hash,
          engine,
          model,
          r.cache_to_put.raw_response,
          now,
          cacheExpiresAt,
        ),
      );
    }
  }
  // Always close the run, even if every prompt failed — a row stuck
  // in 'in_progress' is what made check_visibility silently drop
  // engines pre-fix.
  const okCount = results.filter((r) => r.status === 'ok').length;
  stmts.push(
    env.DIGESTSEO_DB.prepare(
      `UPDATE runs
          SET status = 'completed',
              completed_at = ?,
              prompts_completed = ?
        WHERE id = ?`,
    ).bind(now, okCount, runId),
  );
  if (stmts.length > 0) {
    await env.DIGESTSEO_DB.batch(stmts);
  }
}

interface ResponseJoinRow {
  id: string;
  run_id: string;
  prompt_id: string;
  prompt_text: string;
  engine: string;
  raw_response: string;
  brand_mentioned: number;
  brand_cited_with_link: number;
  cited_urls_json: string | null;
  competitors_mentioned_json: string | null;
  engine_citations_json: string | null;
  status: string;
  error_message: string | null;
  captured_at: number;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

// Only returns status='ok' rows. Scoring and tool handlers must never
// see 'failed' or 'skipped' rows — they'd be counted as zero-mention
// hits and pollute every aggregate.
export async function getResponsesForRun(
  env: DbEnv,
  runId: string,
): Promise<PromptResponse[]> {
  const { results } = await env.DIGESTSEO_DB.prepare(
    `SELECT pr.id, pr.run_id, pr.prompt_id, p.text AS prompt_text, pr.engine,
            pr.raw_response, pr.brand_mentioned, pr.brand_cited_with_link,
            pr.cited_urls_json, pr.competitors_mentioned_json,
            pr.engine_citations_json, pr.status, pr.error_message, pr.captured_at
       FROM prompt_responses pr
       JOIN prompts p ON p.id = pr.prompt_id
      WHERE pr.run_id = ?
        AND pr.status = 'ok'`,
  )
    .bind(runId)
    .all<ResponseJoinRow>();
  return (results ?? []).map((row) => ({
    id: row.id,
    run_id: row.run_id,
    prompt_id: row.prompt_id,
    prompt_text: row.prompt_text,
    engine: row.engine,
    raw_response: row.raw_response,
    brand_mentioned: row.brand_mentioned,
    brand_cited_with_link: row.brand_cited_with_link,
    cited_urls: parseJsonArray(row.cited_urls_json),
    competitors_mentioned: parseJsonArray(row.competitors_mentioned_json),
    engine_citations: parseJsonArray(row.engine_citations_json),
    status: (row.status as ResponseStatus) ?? 'ok',
    error_message: row.error_message,
    captured_at: row.captured_at,
  }));
}

export interface NewPromptInput {
  text: string;
  intent_stage: string | null;
  shape: string | null;
}

export async function replacePrompts(
  env: DbEnv,
  brandId: string,
  prompts: NewPromptInput[],
): Promise<number> {
  const now = Date.now();
  // Soft-delete: mark old prompts inactive so the historical
  // prompt_responses rows keep their FK target. getActivePrompts filters
  // active=1, so the new prompts are the only ones future runs see.
  const stmts = [
    env.DIGESTSEO_DB.prepare(
      'UPDATE prompts SET active = 0 WHERE brand_id = ? AND active = 1',
    ).bind(brandId),
    ...prompts.map((p) =>
      env.DIGESTSEO_DB.prepare(
        `INSERT INTO prompts (id, brand_id, text, intent_stage, shape, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).bind(randomId(), brandId, p.text, p.intent_stage, p.shape, now),
    ),
  ];
  await env.DIGESTSEO_DB.batch(stmts);
  return prompts.length;
}

export async function cacheGet(
  env: DbEnv,
  promptHash: string,
  engine: string,
  model: string,
): Promise<CachedResponse | null> {
  const now = Date.now();
  const row = await env.DIGESTSEO_DB.prepare(
    `SELECT prompt_hash, engine, model, raw_response, captured_at, expires_at
       FROM shared_prompt_cache
      WHERE prompt_hash = ? AND engine = ? AND model = ? AND expires_at > ?`,
  )
    .bind(promptHash, engine, model, now)
    .first<CachedResponse>();
  return row ?? null;
}

// Bulk version of cacheGet: one D1 subrequest for N hashes instead of
// N separate cacheGet calls. Without this, a /admin/run-engine run for
// 20 prompts costs 20 cacheGet subrequests, plus 20 cachePuts, plus 20
// inserts, plus ~5 updateRuns, plus ~4 init reads — well over the
// Workers free-plan 50-cap. Returns a hash → raw_response map for the
// entries that hit the cache; misses are absent from the map.
export async function bulkCacheGet(
  env: DbEnv,
  promptHashes: string[],
  engine: string,
  model: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (promptHashes.length === 0) return map;
  const now = Date.now();
  const placeholders = promptHashes.map(() => '?').join(', ');
  const { results } = await env.DIGESTSEO_DB.prepare(
    `SELECT prompt_hash, raw_response
       FROM shared_prompt_cache
      WHERE prompt_hash IN (${placeholders})
        AND engine = ? AND model = ? AND expires_at > ?`,
  )
    .bind(...promptHashes, engine, model, now)
    .all<{ prompt_hash: string; raw_response: string }>();
  for (const row of results ?? []) {
    map.set(row.prompt_hash, row.raw_response);
  }
  return map;
}

export async function cachePut(
  env: DbEnv,
  promptHash: string,
  engine: string,
  model: string,
  rawResponse: string,
  ttlSeconds: number,
): Promise<void> {
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  await env.DIGESTSEO_DB.prepare(
    `INSERT INTO shared_prompt_cache
       (prompt_hash, engine, model, raw_response, captured_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(prompt_hash, engine, model)
     DO UPDATE SET raw_response = excluded.raw_response,
                   captured_at = excluded.captured_at,
                   expires_at = excluded.expires_at`,
  )
    .bind(promptHash, engine, model, rawResponse, now, expiresAt)
    .run();
}
