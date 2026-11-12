// D1 implementation of the Db contract (src/db/types.ts). This is the
// former src/db.ts, reshaped from free functions taking a DbEnv into
// methods on an object so the Worker and the local CLI share one
// interface. Worker-only file — imports Workers types.

import { LIVE_RUN_STALE_AFTER_MS } from './types';
import type {
  Brand,
  BrandSummary,
  CachedResponse,
  CitationPageOptions,
  CitationRow,
  CitationSourceRow,
  ComparisonEvidenceRow,
  CreateBrandInput,
  Db,
  EnginePromptResult,
  InsertPromptResponseInput,
  LiveRunReservation,
  NewPromptInput,
  Prompt,
  PromptResponse,
  ResponseStatus,
  Run,
  UpdateBrandFields,
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
  aliases_json: string | null;
  exclude_terms_json: string | null;
  refresh_frequency: string;
  created_at: number;
  updated_at: number;
  identity_changed_at: number | null;
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
    aliases: parseJsonArray(row.aliases_json),
    exclude_terms: parseJsonArray(row.exclude_terms_json),
    refresh_frequency: row.refresh_frequency,
    created_at: row.created_at,
    updated_at: row.updated_at,
    identity_changed_at: row.identity_changed_at,
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
          'SELECT id, user_id, domain, name, category, competitors_json, aliases_json, exclude_terms_json, refresh_frequency, created_at, updated_at, identity_changed_at FROM brands WHERE id = ?',
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

    async getPromptsByIds(promptIds: string[]): Promise<Prompt[]> {
      if (promptIds.length === 0) return [];
      const placeholders = promptIds.map(() => '?').join(', ');
      const { results } = await d1
        .prepare(
          `SELECT id, brand_id, text, intent_stage, shape, active, created_at
             FROM prompts
            WHERE id IN (${placeholders})`,
        )
        .bind(...promptIds)
        .all<Prompt>();
      const byId = new Map((results ?? []).map((prompt) => [prompt.id, prompt]));
      return promptIds.flatMap((id) => {
        const prompt = byId.get(id);
        return prompt ? [prompt] : [];
      });
    },

    async upsertUser(id: string, email: string): Promise<void> {
      const now = Date.now();
      await d1
        .prepare(
          `INSERT OR IGNORE INTO users (id, email, plan, created_at, updated_at)
           VALUES (?, ?, 'free', ?, ?)`,
        )
        .bind(id, email, now, now)
        .run();
    },

    async createBrand(input: CreateBrandInput): Promise<void> {
      const now = Date.now();
      await d1
        .prepare(
          `INSERT OR IGNORE INTO brands
             (id, user_id, domain, name, category, competitors_json,
              aliases_json, exclude_terms_json,
              refresh_frequency, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.user_id,
          input.domain,
          input.name,
          input.category,
          JSON.stringify(input.competitors),
          JSON.stringify(input.aliases),
          JSON.stringify(input.exclude_terms),
          input.refresh_frequency,
          now,
          now,
        )
        .run();
    },

    async updateBrand(brandId: string, fields: UpdateBrandFields): Promise<void> {
      const now = Date.now();
      await d1
        .prepare(
          `UPDATE brands
              SET domain = ?, name = ?, category = ?, competitors_json = ?,
                  aliases_json = ?, exclude_terms_json = ?, refresh_frequency = ?,
                  updated_at = ?,
                  identity_changed_at = CASE WHEN ? = 1 THEN ? ELSE identity_changed_at END
            WHERE id = ?`,
        )
        .bind(
          fields.domain,
          fields.name,
          fields.category,
          JSON.stringify(fields.competitors),
          JSON.stringify(fields.aliases),
          JSON.stringify(fields.exclude_terms),
          fields.refresh_frequency,
          now,
          fields.identity_changed ? 1 : 0,
          now,
          brandId,
        )
        .run();
    },

    async listBrands(): Promise<BrandSummary[]> {
      const { results } = await d1
        .prepare(
          `SELECT b.id, b.user_id, b.domain, b.name, b.category,
                  b.competitors_json, b.aliases_json, b.exclude_terms_json,
                  b.refresh_frequency, b.created_at, b.updated_at, b.identity_changed_at,
                  COUNT(p.id) AS active_prompts
             FROM brands b
             LEFT JOIN prompts p ON p.brand_id = b.id AND p.active = 1
            GROUP BY b.id
            ORDER BY b.created_at ASC`,
        )
        .all<BrandRow & { active_prompts: number }>();
      return (results ?? []).map((row) => ({
        ...rowToBrand(row),
        active_prompts: Number(row.active_prompts ?? 0),
      }));
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

    async reserveLiveRun(
      brand: Brand,
      engine: string,
      promptsTotal: number,
    ): Promise<LiveRunReservation | null> {
      const now = Date.now();
      const cutoff = now - LIVE_RUN_STALE_AFTER_MS;
      const run: Run = {
        id: randomId(),
        brand_id: brand.id,
        engine,
        mode: 'live',
        status: 'pending',
        batch_id: null,
        prompts_total: promptsTotal,
        prompts_completed: 0,
        cost_eur_estimate: null,
        error: null,
        started_at: now,
        completed_at: null,
      };
      // D1 serializes writes to the database; keep the exclusion predicate
      // inside the INSERT, never in a separate preflight read.
      const result = await d1
        .prepare(
          `INSERT INTO runs
           (id, brand_id, engine, mode, status, batch_id, prompts_total,
            prompts_completed, cost_eur_estimate, error, started_at, completed_at)
         SELECT ?, ?, ?, 'live', 'pending', NULL, ?, 0, NULL, NULL, ?, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM runs WHERE brand_id = ? AND engine = ?
              AND mode = 'live' AND status IN ('pending', 'in_progress')
              AND started_at > ?
          )`,
        )
        .bind(run.id, brand.id, engine, promptsTotal, now, brand.id, engine, cutoff)
        .run();
      if ((result.meta.changes ?? 0) > 0) return { run, started: true };
      const active = await d1
        .prepare(
          `SELECT * FROM runs WHERE brand_id = ? AND engine = ?
           AND mode = 'live' AND status IN ('pending', 'in_progress')
           AND started_at > ? ORDER BY started_at DESC LIMIT 1`,
        )
        .bind(brand.id, engine, cutoff)
        .first<Run>();
      return active ? { run: active, started: false } : null;
    },

    async claimPendingLiveRun(runId: string): Promise<boolean> {
      const result = await d1.prepare(
        "UPDATE runs SET status = 'in_progress' WHERE id = ? AND mode = 'live' AND status = 'pending'",
      ).bind(runId).run();
      return (result.meta.changes ?? 0) > 0;
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

    async failRunIfInProgress(runId: string, error: string): Promise<boolean> {
      const result = await d1
        .prepare(
          `UPDATE runs
              SET status = 'failed', error = ?, completed_at = ?
             WHERE id = ? AND status IN ('pending', 'in_progress')`,
        )
        .bind(error.slice(0, 500), Date.now(), runId)
        .run();
      return (result.meta.changes ?? 0) > 0;
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
      mode?: Run['mode'],
    ): Promise<Run | null> {
      const modeClause = mode ? ' AND r.mode = ?' : '';
      const row = await d1
        .prepare(
          `SELECT r.id, r.brand_id, r.engine, r.mode, r.status, r.batch_id,
                  r.prompts_total, r.prompts_completed, r.cost_eur_estimate,
                  r.error, r.started_at, r.completed_at
             FROM runs r
            WHERE r.brand_id = ? AND r.engine = ?${modeClause}
              AND EXISTS (
                SELECT 1 FROM prompt_responses pr
                 WHERE pr.run_id = r.id AND pr.status = 'ok'
              )
            ORDER BY COALESCE(r.completed_at, r.started_at) DESC
            LIMIT 1`,
        )
        .bind(...(mode ? [brandId, engine, mode] : [brandId, engine]))
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

    // Cron-driven refresh selection. When the configured engine list is
    // supplied, a brand is due if ANY configured engine lacks full coverage
    // of its current active prompts or exceeds its cadence. Recent attempts
    // are cooled down for 24h and limited to two attempts per rolling week
    // for weekly brands to protect paid-provider quotas.
    async getBrandsDueForRefresh(engines?: string[]): Promise<Brand[]> {
      const now = Date.now();
      const weeklyCutoff = now - 7 * 24 * 60 * 60 * 1000;
      const dailyCutoff = now - 24 * 60 * 60 * 1000;
      const retryCutoff = dailyCutoff;
      const targetEngines = [...new Set(engines ?? [])];
      if (targetEngines.length > 0) {
        const values = targetEngines.map(() => '(?)').join(', ');
        const { results } = await d1
          .prepare(
            `WITH target_engines(engine) AS (VALUES ${values}),
                  latest_complete AS (
                    SELECT r.brand_id, r.engine,
                           MAX(COALESCE(r.completed_at, r.started_at)) AS last_complete_run
                      FROM runs r
                     WHERE r.mode = 'live'
                       AND EXISTS (SELECT 1 FROM prompts p WHERE p.brand_id = r.brand_id AND p.active = 1)
                       AND NOT EXISTS (
                         SELECT 1 FROM prompts p
                          WHERE p.brand_id = r.brand_id AND p.active = 1
                            AND NOT EXISTS (
                              SELECT 1 FROM prompt_responses pr
                               WHERE pr.run_id = r.id AND pr.prompt_id = p.id AND pr.status = 'ok'
                            )
                     )
                     GROUP BY r.brand_id, r.engine
                  ),
                  latest_attempt AS (
                    SELECT brand_id, engine, MAX(started_at) AS last_attempt,
                           SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS attempts_week
                      FROM runs WHERE mode = 'live' GROUP BY brand_id, engine
                  )
             SELECT b.id, b.user_id, b.domain, b.name, b.category, b.competitors_json,
                    b.aliases_json, b.exclude_terms_json,
                    b.refresh_frequency, b.created_at, b.updated_at
               FROM brands b
              WHERE b.refresh_frequency <> 'manual'
                AND EXISTS (SELECT 1 FROM prompts p WHERE p.brand_id = b.id AND p.active = 1)
                AND EXISTS (
                SELECT 1
                  FROM target_engines te
                  LEFT JOIN latest_complete lc
                    ON lc.brand_id = b.id AND lc.engine = te.engine
                  LEFT JOIN latest_attempt la
                    ON la.brand_id = b.id AND la.engine = te.engine
                 WHERE (lc.last_complete_run IS NULL
                    OR (b.refresh_frequency = 'weekly' AND lc.last_complete_run < ?)
                    OR (b.refresh_frequency = 'daily'  AND lc.last_complete_run < ?))
                   AND (la.last_attempt IS NULL OR la.last_attempt < ?)
                   AND (b.refresh_frequency <> 'weekly' OR COALESCE(la.attempts_week, 0) < 2)
              )`,
          )
          .bind(...targetEngines, weeklyCutoff, weeklyCutoff, dailyCutoff, retryCutoff)
          .all<BrandRow>();
        return (results ?? []).map(rowToBrand);
      }

      const { results } = await d1
        .prepare(
          `SELECT b.id, b.user_id, b.domain, b.name, b.category, b.competitors_json,
                  b.aliases_json, b.exclude_terms_json,
                  b.refresh_frequency, b.created_at, b.updated_at,
                  MAX(CASE WHEN
                    EXISTS (SELECT 1 FROM prompts p WHERE p.brand_id = b.id AND p.active = 1)
                    AND NOT EXISTS (
                      SELECT 1 FROM prompts p WHERE p.brand_id = b.id AND p.active = 1
                        AND NOT EXISTS (
                          SELECT 1 FROM prompt_responses pr
                           WHERE pr.run_id = r.id AND pr.prompt_id = p.id AND pr.status = 'ok'
                        )
                    )
                    THEN COALESCE(r.completed_at, r.started_at) END) AS last_complete_run,
                  MAX(r.started_at) AS last_attempt,
                  SUM(CASE WHEN r.started_at >= ? THEN 1 ELSE 0 END) AS attempts_week
             FROM brands b
             LEFT JOIN runs r ON r.brand_id = b.id AND r.mode = 'live'
            WHERE EXISTS (SELECT 1 FROM prompts p WHERE p.brand_id = b.id AND p.active = 1)
            GROUP BY b.id
           HAVING b.refresh_frequency <> 'manual'
              AND (
                last_complete_run IS NULL
                OR (b.refresh_frequency = 'weekly' AND last_complete_run < ?)
                OR (b.refresh_frequency = 'daily'  AND last_complete_run < ?)
              )
              AND (last_attempt IS NULL OR last_attempt < ?)
              AND (b.refresh_frequency <> 'weekly' OR COALESCE(attempts_week, 0) < 2)`,
        )
        .bind(weeklyCutoff, weeklyCutoff, dailyCutoff, retryCutoff)
        .all<BrandRow & { last_complete_run: number | null; last_attempt: number | null }>();
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
      options = {},
    ): Promise<void> {
      const now = Date.now();
      const cacheExpiresAt = now + cacheTtlSeconds * 1000;
      const stmts: D1PreparedStatement[] = [];
      if (options.replaceExisting) {
        stmts.push(
          d1
            .prepare('DELETE FROM prompt_responses WHERE run_id = ?')
            .bind(runId),
        );
      }
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

    async getResponsesSince(
      brandId: string,
      since: number,
    ): Promise<ComparisonEvidenceRow[]> {
      const { results } = await d1
        .prepare(
          `WITH ranked AS (
             SELECT pr.id, pr.run_id, pr.prompt_id, pr.engine,
                    pr.brand_mentioned, pr.competitors_mentioned_json,
                    pr.status, pr.captured_at, r.started_at AS run_started_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY pr.run_id, pr.engine, pr.prompt_id
                      ORDER BY pr.captured_at DESC, pr.id DESC
                    ) AS retry_rank
               FROM prompt_responses pr
               JOIN runs r ON r.id = pr.run_id
              WHERE r.brand_id = ?
                AND pr.captured_at >= ?
                AND pr.status = 'ok'
           )
           SELECT ranked.id, ranked.run_id, ranked.prompt_id,
                  p.text AS prompt_text, ranked.engine,
                  ranked.brand_mentioned, ranked.competitors_mentioned_json,
                  ranked.status, ranked.captured_at, ranked.run_started_at
             FROM ranked
             JOIN prompts p ON p.id = ranked.prompt_id
            WHERE ranked.retry_rank = 1
            ORDER BY ranked.captured_at ASC, ranked.id ASC`,
        )
        .bind(brandId, since)
        .all<Pick<ResponseJoinRow,
          'id' | 'run_id' | 'prompt_id' | 'prompt_text' | 'engine' |
          'brand_mentioned' | 'competitors_mentioned_json' | 'status' | 'captured_at'> &
          { run_started_at: number }>();
      return (results ?? []).map((row) => ({
        id: row.id,
        run_id: row.run_id,
        prompt_id: row.prompt_id,
        prompt_text: row.prompt_text,
        engine: row.engine,
        brand_mentioned: row.brand_mentioned,
        competitors_mentioned: parseJsonArray(row.competitors_mentioned_json),
        status: (row.status as ResponseStatus) ?? 'ok',
        captured_at: row.captured_at,
        run_started_at: row.run_started_at,
      }));
    },

    async getCitationSourceRows(
      brandId: string,
      since: number,
      until: number,
      engine?: string,
    ): Promise<CitationSourceRow[]> {
      // Match SQLite's per-run/prompt retry deduplication and frozen window.
      const { results } = await d1
        .prepare(
          `SELECT pr.id, pr.prompt_id, pr.engine, r.mode AS mode, r.started_at AS run_started_at, pr.engine_citations_json, pr.captured_at
             FROM prompt_responses pr
             JOIN runs r ON r.id = pr.run_id
            WHERE r.brand_id = ?
              AND pr.captured_at >= ?
              AND pr.captured_at <= ?
              AND pr.status = 'ok'
              AND NOT EXISTS (
                SELECT 1 FROM prompt_responses newer
                 WHERE newer.run_id = pr.run_id
                   AND newer.prompt_id = pr.prompt_id
                   AND newer.status = 'ok'
                   AND newer.captured_at <= ?
                   AND (newer.captured_at > pr.captured_at
                     OR (newer.captured_at = pr.captured_at AND newer.id > pr.id))
              )
              ${engine ? 'AND pr.engine = ?' : ''}
            ORDER BY pr.captured_at ASC, pr.id ASC`,
        )
        .bind(...(engine ? [brandId, since, until, until, engine] : [brandId, since, until, until]))
        .all<Omit<CitationSourceRow, 'engine_citations'> & { engine_citations_json: string | null }>();
      return (results ?? []).map(({ engine_citations_json, ...row }) => ({
        ...row,
        engine_citations: parseJsonArray(engine_citations_json),
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
      // Score the newest successful observation per run/prompt, as current
      // visibility scoring does; retries must not inflate the denominator.
      // The INNER JOIN also drops runs with
      // zero ok rows entirely — a fully-failed run is "no data",
      // not a real score of 0. COALESCE on the timestamp matches
      // getLatestCompletedRun's stance: partially-finished runs
      // (stuck at in_progress) still count toward history.
      const { results } = await d1
        .prepare(
          `SELECT r.id AS run_id, r.engine, r.mode, r.started_at,
                  COALESCE(r.completed_at, r.started_at) AS completed_at,
                  COUNT(pr.id) AS total,
                  SUM(pr.brand_mentioned) AS hits,
                  r.prompts_total AS roster_expected,
                  (SELECT COUNT(DISTINCT all_pr.prompt_id)
                     FROM prompt_responses all_pr WHERE all_pr.run_id = r.id) AS roster_observed,
                  (SELECT GROUP_CONCAT(DISTINCT all_pr.prompt_id)
                     FROM prompt_responses all_pr WHERE all_pr.run_id = r.id) AS roster_ids_csv
             FROM runs r
             JOIN prompt_responses pr
               ON pr.run_id = r.id AND pr.status = 'ok'
              AND NOT EXISTS (
                SELECT 1 FROM prompt_responses newer
                 WHERE newer.run_id = pr.run_id
                   AND newer.prompt_id = pr.prompt_id
                   AND newer.status = 'ok'
                   AND (newer.captured_at > pr.captured_at
                     OR (newer.captured_at = pr.captured_at AND newer.id > pr.id))
              )
            WHERE r.brand_id = ?
              AND COALESCE(r.completed_at, r.started_at) >= ?
            GROUP BY r.id, r.engine
            ORDER BY COALESCE(r.completed_at, r.started_at) ASC`,
        )
        .bind(brandId, since)
        .all<VisibilityHistoryRow>();
      return results ?? [];
    },

    async getCitationRows(
      brandId: string,
      since: number,
      engine?: string,
      page?: CitationPageOptions,
    ): Promise<CitationRow[]> {
      let sql = `SELECT pr.id AS response_id, r.engine AS engine, r.mode AS mode, r.started_at AS run_started_at,
                  p.text AS prompt, pr.raw_response,
                  pr.brand_mentioned, pr.brand_cited_with_link,
                  pr.cited_urls_json, pr.engine_citations_json,
                  pr.captured_at, pr.run_id, pr.prompt_id
             FROM prompt_responses pr
             JOIN runs r ON r.id = pr.run_id
             JOIN prompts p ON p.id = pr.prompt_id
            WHERE r.brand_id = ?
              AND pr.captured_at >= ?
              AND (pr.brand_mentioned = 1 OR pr.brand_cited_with_link = 1)
              AND pr.status = 'ok'`;
      const params: unknown[] = [brandId, since];
      if (engine) {
        sql += ' AND r.engine = ?';
        params.push(engine);
      }
      if (page?.until !== undefined) {
        sql += ' AND pr.captured_at <= ?';
        params.push(page.until);
      }
      if (page?.before) {
        const { captured_at, run_id, prompt_id, response_id } = page.before;
        if (response_id) {
          sql += ` AND (pr.captured_at < ? OR
            (pr.captured_at = ? AND (pr.run_id < ? OR
              (pr.run_id = ? AND (pr.prompt_id < ? OR
                (pr.prompt_id = ? AND pr.id < ?))))))`;
          params.push(captured_at, captured_at, run_id, run_id, prompt_id, prompt_id, response_id);
        } else {
          sql += ` AND (pr.captured_at < ? OR
            (pr.captured_at = ? AND (pr.run_id < ? OR
              (pr.run_id = ? AND pr.prompt_id < ?))))`;
          params.push(captured_at, captured_at, run_id, run_id, prompt_id);
        }
      }
      sql += ' ORDER BY pr.captured_at DESC, pr.run_id DESC, pr.prompt_id DESC, pr.id DESC LIMIT ?';
      params.push(page?.limit ?? 50);
      const { results } = await d1
        .prepare(sql)
        .bind(...params)
        .all<CitationRow>();
      return results ?? [];
    },
  };
}
