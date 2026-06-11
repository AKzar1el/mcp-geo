// D1 implementation of the Db contract (src/db/types.ts). This is the
// former src/db.ts, reshaped from free functions taking a DbEnv into
// methods on an object so the Worker and the local CLI share one
// interface. Worker-only file — imports Workers types.

import type {
  Brand,
  CachedResponse,
  CitationRow,
  Db,
  EnginePromptResult,
  InsertPromptResponseInput,
  NewPromptInput,
  Prompt,
  PromptResponse,
  ResponseStatus,
  Run,
  UpdateRunFields,
  VisibilityHistoryRow,
} from './types';

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

function randomId(): string {
  return crypto.randomUUID();
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

export function createD1Db(d1: D1Database): Db {
  return {
    async getBrand(brandId: string): Promise<Brand | null> {
      const row = await d1
        .prepare(
          'SELECT id, user_id, domain, name, category, competitors_json, refresh_frequency, created_at, updated_at FROM brands WHERE id = ?',
        )
        .bind(brandId)
        .first<BrandRow>();
      if (!row) return null;
      return rowToBrand(row);
    },

    async getActivePrompts(brandId: string): Promise<Prompt[]> {
      const { results } = await d1
        .prepare(
          'SELECT id, brand_id, text, intent_stage, shape, active, created_at FROM prompts WHERE brand_id = ? AND active = 1 ORDER BY created_at ASC',
        )
        .bind(brandId)
        .all<Prompt>();
      return results ?? [];
    },

    async createRun(
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
      await d1
        .prepare(
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
    },

    async updateRun(runId: string, fields: UpdateRunFields): Promise<void> {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      for (const [key, value] of Object.entries(fields)) {
        setClauses.push(`${key} = ?`);
        values.push(value);
      }
      if (setClauses.length === 0) return;
      values.push(runId);
      await d1
        .prepare(`UPDATE runs SET ${setClauses.join(', ')} WHERE id = ?`)
        .bind(...values)
        .run();
    },

    async getLatestRun(brandId: string, engine: string): Promise<Run | null> {
      const row = await d1
        .prepare(
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
    },

    // "Latest run that produced any usable data for this (brand, engine)" —
    // NOT "latest run with status='completed'". A subrequest-cap or wall-time
    // abort can leave the runs row stuck at 'in_progress' even though some
    // prompt_responses rows landed with status='ok'. Anchoring on EXISTS(ok
    // rows) instead of run.status keeps the visibility tools honest about
    // partial data and survives any future incident that interrupts a run.
    async getLatestCompletedRun(
      brandId: string,
      engine: string,
    ): Promise<Run | null> {
      const row = await d1
        .prepare(
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
    },

    async getRunById(runId: string): Promise<Run | null> {
      const row = await d1
        .prepare(
          `SELECT id, brand_id, engine, mode, status, batch_id, prompts_total,
                  prompts_completed, cost_eur_estimate, error, started_at, completed_at
             FROM runs
            WHERE id = ?`,
        )
        .bind(runId)
        .first<Run>();
      return row ?? null;
    },

    // Cron-driven refresh selection. A brand is due if:
    //   - it has no completed run yet (first-time), OR
    //   - its latest completed run is older than the cadence implied by
    //     refresh_frequency ('weekly' → 7d, 'daily' → 1d).
    async getBrandsDueForRefresh(): Promise<Brand[]> {
      const now = Date.now();
      const weeklyCutoff = now - 7 * 24 * 60 * 60 * 1000;
      const dailyCutoff = now - 24 * 60 * 60 * 1000;
      const { results } = await d1
        .prepare(
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
    },

    async insertPromptResponse(
      input: InsertPromptResponseInput,
    ): Promise<void> {
      await d1
        .prepare(
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
    },

    async deleteResponsesForRun(runId: string): Promise<void> {
      await d1
        .prepare('DELETE FROM prompt_responses WHERE run_id = ?')
        .bind(runId)
        .run();
    },

    // One D1 subrequest that writes every prompt's row, every cache entry
    // to back-fill, and the final run status. The bulk pattern is required
    // for the per-engine fan-out to fit inside the Workers free-plan
    // 50-subrequest cap.
    async persistEngineRun(
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
          d1
            .prepare(
              `INSERT INTO prompt_responses
                 (id, run_id, prompt_id, engine, raw_response, brand_mentioned,
                  brand_cited_with_link, cited_urls_json, competitors_mentioned_json,
                  engine_citations_json, status, error_message, captured_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
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
            d1
              .prepare(
                `INSERT INTO shared_prompt_cache
                   (prompt_hash, engine, model, raw_response, captured_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(prompt_hash, engine, model)
                 DO UPDATE SET raw_response = excluded.raw_response,
                               captured_at = excluded.captured_at,
                               expires_at = excluded.expires_at`,
              )
              .bind(
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
        d1
          .prepare(
            `UPDATE runs
                SET status = 'completed',
                    completed_at = ?,
                    prompts_completed = ?
              WHERE id = ?`,
          )
          .bind(now, okCount, runId),
      );
      if (stmts.length > 0) {
        await d1.batch(stmts);
      }
    },

    // Only returns status='ok' rows. Scoring and tool handlers must never
    // see 'failed' or 'skipped' rows — they'd be counted as zero-mention
    // hits and pollute every aggregate.
    async getResponsesForRun(runId: string): Promise<PromptResponse[]> {
      const { results } = await d1
        .prepare(
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
    },

    async replacePrompts(
      brandId: string,
      prompts: NewPromptInput[],
    ): Promise<number> {
      const now = Date.now();
      // Soft-delete: mark old prompts inactive so the historical
      // prompt_responses rows keep their FK target. getActivePrompts filters
      // active=1, so the new prompts are the only ones future runs see.
      const stmts = [
        d1
          .prepare(
            'UPDATE prompts SET active = 0 WHERE brand_id = ? AND active = 1',
          )
          .bind(brandId),
        ...prompts.map((p) =>
          d1
            .prepare(
              `INSERT INTO prompts (id, brand_id, text, intent_stage, shape, active, created_at)
               VALUES (?, ?, ?, ?, ?, 1, ?)`,
            )
            .bind(randomId(), brandId, p.text, p.intent_stage, p.shape, now),
        ),
      ];
      await d1.batch(stmts);
      return prompts.length;
    },

    async cacheGet(
      promptHash: string,
      engine: string,
      model: string,
    ): Promise<CachedResponse | null> {
      const now = Date.now();
      const row = await d1
        .prepare(
          `SELECT prompt_hash, engine, model, raw_response, captured_at, expires_at
             FROM shared_prompt_cache
            WHERE prompt_hash = ? AND engine = ? AND model = ? AND expires_at > ?`,
        )
        .bind(promptHash, engine, model, now)
        .first<CachedResponse>();
      return row ?? null;
    },

    // Bulk version of cacheGet: one D1 subrequest for N hashes instead of
    // N separate cacheGet calls. Returns a hash → raw_response map for the
    // entries that hit the cache; misses are absent from the map.
    async bulkCacheGet(
      promptHashes: string[],
      engine: string,
      model: string,
    ): Promise<Map<string, string>> {
      const map = new Map<string, string>();
      if (promptHashes.length === 0) return map;
      const now = Date.now();
      const placeholders = promptHashes.map(() => '?').join(', ');
      const { results } = await d1
        .prepare(
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
    },

    async cachePut(
      promptHash: string,
      engine: string,
      model: string,
      rawResponse: string,
      ttlSeconds: number,
    ): Promise<void> {
      const now = Date.now();
      const expiresAt = now + ttlSeconds * 1000;
      await d1
        .prepare(
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
    },

    async getVisibilityHistoryRows(
      brandId: string,
      since: number,
    ): Promise<VisibilityHistoryRow[]> {
      // status='ok' filter on the join keeps failed/skipped rows
      // out of COUNT and SUM. Without it, polluted runs report
      // inflated totals with deflated hit rates.
      const { results } = await d1
        .prepare(
          `SELECT r.id AS run_id, r.engine, r.completed_at,
                  COUNT(pr.id) AS total,
                  SUM(pr.brand_mentioned) AS hits
             FROM runs r
             LEFT JOIN prompt_responses pr
               ON pr.run_id = r.id AND pr.status = 'ok'
            WHERE r.brand_id = ?
              AND r.status = 'completed'
              AND r.completed_at IS NOT NULL
              AND r.completed_at >= ?
            GROUP BY r.id, r.engine, r.completed_at
            ORDER BY r.completed_at ASC`,
        )
        .bind(brandId, since)
        .all<VisibilityHistoryRow>();
      return results ?? [];
    },

    async getCitationRows(
      brandId: string,
      since: number,
      engine?: string,
    ): Promise<CitationRow[]> {
      let sql = `SELECT r.engine AS engine, p.text AS prompt, pr.raw_response,
                  pr.brand_mentioned, pr.brand_cited_with_link,
                  pr.cited_urls_json, pr.engine_citations_json,
                  pr.captured_at, pr.run_id, pr.prompt_id
             FROM prompt_responses pr
             JOIN runs r ON r.id = pr.run_id
             JOIN prompts p ON p.id = pr.prompt_id
            WHERE r.brand_id = ?
              AND pr.captured_at >= ?
              AND pr.brand_mentioned = 1
              AND pr.status = 'ok'`;
      const params: unknown[] = [brandId, since];
      if (engine) {
        sql += ' AND r.engine = ?';
        params.push(engine);
      }
      sql += ' ORDER BY pr.captured_at DESC LIMIT 50';
      const { results } = await d1
        .prepare(sql)
        .bind(...params)
        .all<CitationRow>();
      return results ?? [];
    },
  };
}
