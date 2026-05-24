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

export async function getLatestCompletedRun(
  env: DbEnv,
  brandId: string,
  engine: string,
): Promise<Run | null> {
  const row = await env.DIGESTSEO_DB.prepare(
    `SELECT id, brand_id, engine, mode, status, batch_id, prompts_total,
            prompts_completed, cost_eur_estimate, error, started_at, completed_at
       FROM runs
      WHERE brand_id = ? AND engine = ? AND status = 'completed'
      ORDER BY completed_at DESC
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
}

export async function insertPromptResponse(
  env: DbEnv,
  input: InsertPromptResponseInput,
): Promise<void> {
  await env.DIGESTSEO_DB.prepare(
    `INSERT INTO prompt_responses
       (id, run_id, prompt_id, engine, raw_response, brand_mentioned,
        brand_cited_with_link, cited_urls_json, competitors_mentioned_json,
        engine_citations_json, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      Date.now(),
    )
    .run();
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

export async function getResponsesForRun(
  env: DbEnv,
  runId: string,
): Promise<PromptResponse[]> {
  const { results } = await env.DIGESTSEO_DB.prepare(
    `SELECT pr.id, pr.run_id, pr.prompt_id, p.text AS prompt_text, pr.engine,
            pr.raw_response, pr.brand_mentioned, pr.brand_cited_with_link,
            pr.cited_urls_json, pr.competitors_mentioned_json,
            pr.engine_citations_json, pr.captured_at
       FROM prompt_responses pr
       JOIN prompts p ON p.id = pr.prompt_id
      WHERE pr.run_id = ?`,
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
