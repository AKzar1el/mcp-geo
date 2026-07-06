// better-sqlite3 implementation of the Db contract (src/db/types.ts)
// for the local stdio CLI. D1 speaks SQLite dialect, so every query is
// a 1:1 port of src/db/d1.ts — only the driver call shapes differ.
//
// On open:
//   - resolves the database path (explicit arg → DIGESTSEO_DB_PATH env
//     var → ~/.digestseo/digestseo.sqlite) and creates the parent dir
//   - applies migrations/*.sql in filename order, tracked in a
//     _migrations table so re-opening never re-applies one
//
// Node-only file: excluded from the Worker tsconfig, compiled by
// tsconfig.node.json.

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Brand,
  BrandSummary,
  CachedResponse,
  CitationRow,
  CreateBrandInput,
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
} from './types.js';

export interface SqliteDb extends Db {
  // Escape hatch for tests and power users (e.g. seeding a brand row —
  // the Db contract only mirrors the query helpers the tools use).
  raw: Database.Database;
  close(): void;
}

export function defaultDbPath(): string {
  return (
    process.env.DIGESTSEO_DB_PATH ??
    join(homedir(), '.digestseo', 'digestseo.sqlite')
  );
}

// src/db/sqlite.ts and the compiled dist/db/sqlite.js both sit two
// levels below the package root, where migrations/ lives (it ships in
// the npm tarball via package.json "files").
function migrationsDir(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name       TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{
      name: string;
    }>).map((r) => r.name),
  );
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
      ).run(file, Date.now());
    })();
  }
}

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
  };
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

export function openSqliteDb(path?: string): SqliteDb {
  const dbPath = path ?? defaultDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  // WAL keeps reads cheap while an engine run is writing; FK
  // enforcement matches D1 behavior (SQLite defaults it off).
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);

  return {
    raw: sqlite,
    close(): void {
      sqlite.close();
    },

    async getBrand(brandId: string): Promise<Brand | null> {
      const row = sqlite
        .prepare(
          'SELECT id, user_id, domain, name, category, competitors_json, aliases_json, exclude_terms_json, refresh_frequency, created_at, updated_at FROM brands WHERE id = ?',
        )
        .get(brandId) as BrandRow | undefined;
      if (!row) return null;
      return rowToBrand(row);
    },

    async getActivePrompts(brandId: string): Promise<Prompt[]> {
      return sqlite
        .prepare(
          'SELECT id, brand_id, text, intent_stage, shape, active, created_at FROM prompts WHERE brand_id = ? AND active = 1 ORDER BY created_at ASC',
        )
        .all(brandId) as Prompt[];
    },

    async upsertUser(id: string, email: string): Promise<void> {
      const now = Date.now();
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO users (id, email, plan, created_at, updated_at)
           VALUES (?, ?, 'free', ?, ?)`,
        )
        .run(id, email, now, now);
    },

    async createBrand(input: CreateBrandInput): Promise<void> {
      const now = Date.now();
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO brands
             (id, user_id, domain, name, category, competitors_json,
              aliases_json, exclude_terms_json,
              refresh_frequency, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
    },

    async listBrands(): Promise<BrandSummary[]> {
      const rows = sqlite
        .prepare(
          `SELECT b.id, b.user_id, b.domain, b.name, b.category,
                  b.competitors_json, b.aliases_json, b.exclude_terms_json,
                  b.refresh_frequency, b.created_at, b.updated_at,
                  COUNT(p.id) AS active_prompts
             FROM brands b
             LEFT JOIN prompts p ON p.brand_id = b.id AND p.active = 1
            GROUP BY b.id
            ORDER BY b.created_at ASC`,
        )
        .all() as Array<BrandRow & { active_prompts: number }>;
      return rows.map((row) => ({
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
        id: randomUUID(),
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
      sqlite
        .prepare(
          `INSERT INTO runs
             (id, brand_id, engine, mode, status, batch_id, prompts_total,
              prompts_completed, cost_eur_estimate, error, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, NULL)`,
        )
        .run(
          run.id,
          run.brand_id,
          run.engine,
          run.mode,
          run.status,
          run.batch_id,
          run.prompts_total,
          run.started_at,
        );
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
      sqlite
        .prepare(`UPDATE runs SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...(values as never[]));
    },

    async getLatestRun(brandId: string, engine: string): Promise<Run | null> {
      const row = sqlite
        .prepare(
          `SELECT id, brand_id, engine, mode, status, batch_id, prompts_total,
                  prompts_completed, cost_eur_estimate, error, started_at, completed_at
             FROM runs
            WHERE brand_id = ? AND engine = ?
            ORDER BY started_at DESC
            LIMIT 1`,
        )
        .get(brandId, engine) as Run | undefined;
      return row ?? null;
    },

    // Anchors on EXISTS(ok rows), NOT run.status='completed' — see
    // src/db/d1.ts for the incident rationale.
    async getLatestCompletedRun(
      brandId: string,
      engine: string,
    ): Promise<Run | null> {
      const row = sqlite
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
        .get(brandId, engine) as Run | undefined;
      return row ?? null;
    },

    async getRunById(runId: string): Promise<Run | null> {
      const row = sqlite
        .prepare(
          `SELECT id, brand_id, engine, mode, status, batch_id, prompts_total,
                  prompts_completed, cost_eur_estimate, error, started_at, completed_at
             FROM runs
            WHERE id = ?`,
        )
        .get(runId) as Run | undefined;
      return row ?? null;
    },

    async getBrandsDueForRefresh(): Promise<Brand[]> {
      const now = Date.now();
      const weeklyCutoff = now - 7 * 24 * 60 * 60 * 1000;
      const dailyCutoff = now - 24 * 60 * 60 * 1000;
      const rows = sqlite
        .prepare(
          `SELECT b.id, b.user_id, b.domain, b.name, b.category, b.competitors_json,
                  b.aliases_json, b.exclude_terms_json,
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
        .all(weeklyCutoff, dailyCutoff) as Array<
        BrandRow & { last_run: number | null }
      >;
      return rows.map(rowToBrand);
    },

    async insertPromptResponse(
      input: InsertPromptResponseInput,
    ): Promise<void> {
      sqlite
        .prepare(
          `INSERT INTO prompt_responses
             (id, run_id, prompt_id, engine, raw_response, brand_mentioned,
              brand_cited_with_link, cited_urls_json, competitors_mentioned_json,
              engine_citations_json, status, error_message, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
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
        );
    },

    async deleteResponsesForRun(runId: string): Promise<void> {
      sqlite
        .prepare('DELETE FROM prompt_responses WHERE run_id = ?')
        .run(runId);
    },

    // Single transaction covering every prompt row, every cache
    // back-fill, and the final run close — mirrors d1.ts's D1.batch.
    async persistEngineRun(
      runId: string,
      engine: string,
      model: string,
      cacheTtlSeconds: number,
      results: EnginePromptResult[],
    ): Promise<void> {
      const now = Date.now();
      const cacheExpiresAt = now + cacheTtlSeconds * 1000;
      const insertResponse = sqlite.prepare(
        `INSERT INTO prompt_responses
           (id, run_id, prompt_id, engine, raw_response, brand_mentioned,
            brand_cited_with_link, cited_urls_json, competitors_mentioned_json,
            engine_citations_json, status, error_message, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const upsertCache = sqlite.prepare(
        `INSERT INTO shared_prompt_cache
           (prompt_hash, engine, model, raw_response, captured_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(prompt_hash, engine, model)
         DO UPDATE SET raw_response = excluded.raw_response,
                       captured_at = excluded.captured_at,
                       expires_at = excluded.expires_at`,
      );
      const closeRun = sqlite.prepare(
        `UPDATE runs
            SET status = 'completed',
                completed_at = ?,
                prompts_completed = ?
          WHERE id = ?`,
      );
      sqlite.transaction(() => {
        for (const r of results) {
          insertResponse.run(
            randomUUID(),
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
          );
          if (r.cache_to_put) {
            upsertCache.run(
              r.cache_to_put.prompt_hash,
              engine,
              model,
              r.cache_to_put.raw_response,
              now,
              cacheExpiresAt,
            );
          }
        }
        // Always close the run, even if every prompt failed — a row
        // stuck in 'in_progress' silently drops the engine from
        // check_visibility.
        const okCount = results.filter((r) => r.status === 'ok').length;
        closeRun.run(now, okCount, runId);
      })();
    },

    // Only returns status='ok' rows — see d1.ts.
    async getResponsesForRun(runId: string): Promise<PromptResponse[]> {
      const rows = sqlite
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
        .all(runId) as ResponseJoinRow[];
      return rows.map((row) => ({
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
      const deactivate = sqlite.prepare(
        'UPDATE prompts SET active = 0 WHERE brand_id = ? AND active = 1',
      );
      const insert = sqlite.prepare(
        `INSERT INTO prompts (id, brand_id, text, intent_stage, shape, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      );
      sqlite.transaction(() => {
        // Soft-delete: mark old prompts inactive so historical
        // prompt_responses rows keep their FK target.
        deactivate.run(brandId);
        for (const p of prompts) {
          insert.run(randomUUID(), brandId, p.text, p.intent_stage, p.shape, now);
        }
      })();
      return prompts.length;
    },

    async cacheGet(
      promptHash: string,
      engine: string,
      model: string,
    ): Promise<CachedResponse | null> {
      const now = Date.now();
      const row = sqlite
        .prepare(
          `SELECT prompt_hash, engine, model, raw_response, captured_at, expires_at
             FROM shared_prompt_cache
            WHERE prompt_hash = ? AND engine = ? AND model = ? AND expires_at > ?`,
        )
        .get(promptHash, engine, model, now) as CachedResponse | undefined;
      return row ?? null;
    },

    async bulkCacheGet(
      promptHashes: string[],
      engine: string,
      model: string,
    ): Promise<Map<string, string>> {
      const map = new Map<string, string>();
      if (promptHashes.length === 0) return map;
      const now = Date.now();
      const placeholders = promptHashes.map(() => '?').join(', ');
      const rows = sqlite
        .prepare(
          `SELECT prompt_hash, raw_response
             FROM shared_prompt_cache
            WHERE prompt_hash IN (${placeholders})
              AND engine = ? AND model = ? AND expires_at > ?`,
        )
        .all(...promptHashes, engine, model, now) as Array<{
        prompt_hash: string;
        raw_response: string;
      }>;
      for (const row of rows) {
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
      sqlite
        .prepare(
          `INSERT INTO shared_prompt_cache
             (prompt_hash, engine, model, raw_response, captured_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(prompt_hash, engine, model)
           DO UPDATE SET raw_response = excluded.raw_response,
                         captured_at = excluded.captured_at,
                         expires_at = excluded.expires_at`,
        )
        .run(promptHash, engine, model, rawResponse, now, expiresAt);
    },

    async getVisibilityHistoryRows(
      brandId: string,
      since: number,
    ): Promise<VisibilityHistoryRow[]> {
      // status='ok' filter on the join keeps failed/skipped rows
      // out of COUNT and SUM. The INNER JOIN also drops runs with
      // zero ok rows entirely — a fully-failed run is "no data",
      // not a real score of 0. COALESCE on the timestamp matches
      // getLatestCompletedRun's stance: partially-finished runs
      // (stuck at in_progress) still count toward history.
      return sqlite
        .prepare(
          `SELECT r.id AS run_id, r.engine,
                  COALESCE(r.completed_at, r.started_at) AS completed_at,
                  COUNT(pr.id) AS total,
                  SUM(pr.brand_mentioned) AS hits
             FROM runs r
             JOIN prompt_responses pr
               ON pr.run_id = r.id AND pr.status = 'ok'
            WHERE r.brand_id = ?
              AND COALESCE(r.completed_at, r.started_at) >= ?
            GROUP BY r.id, r.engine
            ORDER BY COALESCE(r.completed_at, r.started_at) ASC`,
        )
        .all(brandId, since) as VisibilityHistoryRow[];
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
      return sqlite.prepare(sql).all(...(params as never[])) as CitationRow[];
    },
  };
}
