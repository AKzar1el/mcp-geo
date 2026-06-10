import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createRun,
  deleteResponsesForRun,
  getActivePrompts,
  getBrand,
  getBrandsDueForRefresh,
  getLatestCompletedRun,
  getResponsesForRun,
  getRunById,
  type Brand,
  type PromptResponse,
} from './db';

import { collectBatch, hostMatchesDomain, submitBatch } from './openai';
import {
  ALL_ENGINES,
  getAvailableEngines,
  isEngineName,
  runEngineInProcess,
  runEngines,
  type EngineName,
} from './engines';
import { generatePrompts } from './prompt-generation';
import {
  analyzeContentGaps,
  FALLBACK_RECOMMENDATIONS,
  type LosingPromptSummary,
} from './content-gap-analysis';
import { computeOverallScore } from './scoring';
import { seedBrand, type SeedBrandInput } from './seed';

export interface Env {
  OAUTH_KV: KVNamespace;
  DIGESTSEO_DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_PROVIDER: any;
  // Engine API keys are opt-in. Set only the ones you have; the rest of
  // the engines skip gracefully. See src/engines.ts:getAvailableEngines.
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  GEMINI_API_KEY?: string;
  SERPAPI_API_KEY?: string;
  // Shared secret gating /admin/* routes.
  SEED_SECRET: string;
  // Optional shared secret gating the OAuth /authorize auto-complete.
  // When set, anyone connecting an MCP client must type this secret
  // into a one-field browser form before a token is issued. When
  // unset, /authorize auto-completes for any client that knows the
  // worker URL — fine for private/obscure deployments, risky for
  // anything you've shared publicly (connected clients can call
  // refresh_brand, which spends your engine API credits).
  CONNECT_SECRET?: string;
  // Service binding back to this same worker. /admin/run-live fans out
  // by self-fetching /admin/run-engine once per engine via env.SELF.
  // A public-URL fetch back to the same hostname triggers Cloudflare's
  // "Worker called itself" guard (error 1042) and never reaches the
  // handler; service bindings route through Cloudflare's internal
  // fabric and bypass that guard. See wrangler.example.jsonc for the
  // matching "services" config.
  SELF: Fetcher;
  // Public URL of the deployed Worker. Cron path (no Request to
  // derive from) requires this; HTTP-triggered paths fall back to
  // `new URL(request.url).origin` when SELF_URL is missing. Set it to
  // your https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev (or custom
  // domain) after the first deploy.
  SELF_URL?: string;
  // Reserved for future use (e.g. a public /check endpoint). The OSS
  // build does not currently reference these but keeps them in scope so
  // forks can wire them up without changing the Env shape.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

interface AgentProps extends Record<string, unknown> {
  user_id: string;
  email: string;
}

const DEV_USER_ID = 'dev-user';
const DEV_USER_EMAIL = 'dev@local';

function filterRequestedEngines(
  env: Env,
  requested: EngineName[] | undefined,
): EngineName[] {
  const available = new Set(getAvailableEngines(env));
  if (!requested || requested.length === 0) return [...available];
  return requested.filter((e) => available.has(e));
}

// Keep in sync with package.json "version".
const SERVER_VERSION = '0.2.1';

export class GeoMcpAgent extends McpAgent<Env, unknown, AgentProps> {
  server = new McpServer({
    name: 'digestseo-mcp',
    version: SERVER_VERSION,
  });

  async init() {
    this.server.registerTool(
      'check_visibility',
      {
        description:
          "Get the latest AI visibility data for a tracked brand: which AI assistants (ChatGPT, Claude, Perplexity, Gemini, Google AI Overviews) cite this brand, for which prompts, and how it compares to competitors. Use when the user asks 'how visible am I on AI?', 'who's citing my brand?', or 'show me my AI visibility score'. Returns stored data — for fresh data, call refresh_brand.",
        inputSchema: {
          brand_id: z.string(),
          engines: z
            .array(
              z.enum([
                'chatgpt',
                'claude',
                'perplexity',
                'gemini',
                'ai_overviews',
              ]),
            )
            .optional(),
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async ({ brand_id, engines }) => {
        const brand = await getBrand(this.env, brand_id);
        if (!brand) {
          throw new Error(
            'Brand not found. Seed the brand via POST /admin/seed first.',
          );
        }

        // getLatestCompletedRun anchors on EXISTS(ok rows) rather than
        // run.status='completed', so partially-finished runs (killed
        // by the subrequest cap, wall time, etc.) still surface their
        // ok rows. Use completed_at when available, started_at as a
        // fallback for in-progress runs.
        const allResponses: PromptResponse[] = [];
        let mostRecentTimestamp = 0;
        for (const engine of ALL_ENGINES) {
          const run = await getLatestCompletedRun(this.env, brand_id, engine);
          if (!run) continue;
          const responses = await getResponsesForRun(this.env, run.id);
          if (responses.length === 0) continue;
          allResponses.push(...responses);
          const ts = run.completed_at ?? run.started_at;
          if (ts > mostRecentTimestamp) mostRecentTimestamp = ts;
        }
        if (allResponses.length === 0) {
          throw new Error(
            'No visibility data yet for this brand. Call refresh_brand to populate it.',
          );
        }
        const scored = computeOverallScore(brand, allResponses);

        const filteredPerEngine = engines
          ? scored.per_engine.filter((e) => engines.includes(e.engine as any))
          : scored.per_engine;

        const payload = {
          brand: {
            id: brand.id,
            name: brand.name,
            domain: brand.domain,
            category: brand.category,
          },
          refreshed_at: new Date(mostRecentTimestamp).toISOString(),
          overall_score: scored.overall_score,
          per_engine: filteredPerEngine,
          top_winning_prompts: scored.top_winning_prompts,
          top_losing_prompts: scored.top_losing_prompts,
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(payload, null, 2) },
          ],
        };
      },
    );

    this.server.registerTool(
      'get_visibility_history',
      {
        description:
          "Get the time-series history of a brand's AI visibility score, broken down per engine. Use when the user asks 'how has my AI visibility changed over time?', 'is my visibility growing or shrinking?', or 'show me the trend for the last month'.",
        inputSchema: {
          brand_id: z.string(),
          days: z.number().min(1).max(365).default(30),
          granularity: z.enum(['daily', 'weekly']).default('weekly'),
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async ({ brand_id, days, granularity }) => {
        const since = Date.now() - days * 86_400_000;
        const { results } = await this.env.DIGESTSEO_DB.prepare(
          // status='ok' filter on the join keeps failed/skipped rows
          // out of COUNT and SUM. The INNER JOIN also drops runs with
          // zero ok rows entirely — a fully-failed run is "no data",
          // not a real score of 0. COALESCE on the timestamp matches
          // getLatestCompletedRun's stance: partially-finished runs
          // (stuck at in_progress) still count toward history.
          `SELECT r.id AS run_id, r.engine,
                  COALESCE(r.completed_at, r.started_at) AS ts,
                  COUNT(pr.id) AS total,
                  SUM(pr.brand_mentioned) AS hits
             FROM runs r
             JOIN prompt_responses pr
               ON pr.run_id = r.id AND pr.status = 'ok'
            WHERE r.brand_id = ?
              AND COALESCE(r.completed_at, r.started_at) >= ?
            GROUP BY r.id, r.engine
            ORDER BY ts ASC`,
        )
          .bind(brand_id, since)
          .all<{
            run_id: string;
            engine: string;
            ts: number;
            total: number | null;
            hits: number | null;
          }>();

        const buckets = new Map<string, Map<string, number>>();
        for (const row of results ?? []) {
          const date = bucketStart(row.ts, granularity);
          const total = Number(row.total ?? 0);
          const hits = Number(row.hits ?? 0);
          const score = total > 0 ? Math.round((100 * hits) / total) : 0;
          let perEngine = buckets.get(date);
          if (!perEngine) {
            perEngine = new Map();
            buckets.set(date, perEngine);
          }
          perEngine.set(row.engine, score);
        }
        const series = [...buckets.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, perEngine]) => {
            const scores = [...perEngine.values()];
            const overall_score =
              scores.length === 0
                ? 0
                : Math.round(
                    scores.reduce((s, x) => s + x, 0) / scores.length,
                  );
            return {
              date,
              overall_score,
              per_engine: Object.fromEntries(perEngine),
            };
          });

        const payload = { brand_id, days, granularity, series };
        return {
          content: [
            { type: 'text', text: JSON.stringify(payload, null, 2) },
          ],
        };
      },
    );

    this.server.registerTool(
      'compare_competitors',
      {
        description:
          "Compare a brand's AI visibility against competitors for the same category. Returns share-of-voice percentages, prompts the user wins, and prompts where competitors win. Use when the user asks 'who beats me in AI search?', 'compare me to my competitors', or 'why does [competitor] get cited more?'.",
        inputSchema: {
          brand_id: z.string(),
          competitor_domains: z.array(z.string()).optional(),
          days: z.number().min(1).max(90).default(7),
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async ({ brand_id, competitor_domains, days }) => {
        const brand = await getBrand(this.env, brand_id);
        if (!brand) {
          throw new Error(
            'Brand not found. Seed the brand via POST /admin/seed first.',
          );
        }
        const targets =
          competitor_domains && competitor_domains.length > 0
            ? competitor_domains
            : brand.competitors;
        if (targets.length === 0) {
          const payload = {
            brand_id,
            days,
            message:
              'No competitor list configured for this brand. Pass competitor_domains or set brand.competitors.',
            your_share_of_voice_pct: 0,
            competitors: [],
            prompts_you_win: [],
            requested_competitor_domains: competitor_domains ?? null,
          };
          return {
            content: [
              { type: 'text', text: JSON.stringify(payload, null, 2) },
            ],
          };
        }

        const since = Date.now() - days * 86_400_000;
        const allResponses: PromptResponse[] = [];
        for (const engine of ALL_ENGINES) {
          const run = await getLatestCompletedRun(this.env, brand_id, engine);
          if (!run) continue;
          const ts = run.completed_at ?? run.started_at;
          if (ts < since) continue;
          const responses = await getResponsesForRun(this.env, run.id);
          allResponses.push(...responses);
        }

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
          return {
            domain,
            share_of_voice_pct: pct(competitorMentions.get(domain) ?? 0),
            prompts_won_against_you: [...wonPrompts.values()].slice(0, 5),
          };
        });

        const winsByPrompt = new Map<
          string,
          {
            prompt: string;
            engines: Set<string>;
            competitors: Set<string>;
          }
        >();
        for (const r of allResponses) {
          if (r.brand_mentioned !== 1) continue;
          const existing = winsByPrompt.get(r.prompt_id);
          if (existing) {
            existing.engines.add(r.engine);
            for (const c of r.competitors_mentioned) {
              if (targets.includes(c)) existing.competitors.add(c);
            }
          } else {
            winsByPrompt.set(r.prompt_id, {
              prompt: r.prompt_text,
              engines: new Set([r.engine]),
              competitors: new Set(
                r.competitors_mentioned.filter((c) => targets.includes(c)),
              ),
            });
          }
        }
        const prompts_you_win = [...winsByPrompt.values()]
          .sort((a, b) => b.engines.size - a.engines.size)
          .slice(0, 5)
          .map((w) => ({
            prompt: w.prompt,
            you_cited_by: [...w.engines].sort(),
            competitors_cited: [...w.competitors].sort(),
          }));

        const payload = {
          brand_id,
          days,
          your_share_of_voice_pct: pct(brandMentions),
          competitors: competitorsOut,
          prompts_you_win,
          requested_competitor_domains: competitor_domains ?? null,
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(payload, null, 2) },
          ],
        };
      },
    );

    this.server.registerTool(
      'get_citations',
      {
        description:
          "Get the actual citation events where AI assistants mentioned or linked to the brand. Each citation includes the prompt that triggered it, the LLM's response excerpt, and whether it was a linked citation, a mention without a link, or a paraphrase. Use when the user asks 'show me where I'm cited', 'what are ChatGPT/Claude/Perplexity actually saying about my brand?', or 'give me proof of AI citations'.",
        inputSchema: {
          brand_id: z.string(),
          days: z.number().min(1).max(90).default(14),
          engine: z
            .enum([
              'chatgpt',
              'claude',
              'perplexity',
              'gemini',
              'ai_overviews',
            ])
            .optional(),
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async ({ brand_id, days, engine }) => {
        const brand = await getBrand(this.env, brand_id);
        if (!brand) {
          throw new Error(
            'Brand not found. Seed the brand via POST /admin/seed first.',
          );
        }
        const since = Date.now() - days * 86_400_000;
        let sql =
          `SELECT r.engine AS engine, p.text AS prompt, pr.raw_response,
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
        const params: unknown[] = [brand_id, since];
        if (engine) {
          sql += ' AND r.engine = ?';
          params.push(engine);
        }
        sql += ' ORDER BY pr.captured_at DESC LIMIT 50';
        const { results } = await this.env.DIGESTSEO_DB.prepare(sql)
          .bind(...params)
          .all<{
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
          }>();

        const citations = (results ?? []).map((row) => {
          const citedHosts = parseStringArray(row.cited_urls_json);
          const engineHosts = parseStringArray(row.engine_citations_json);
          return {
            id: citationId(row.run_id, row.prompt_id),
            engine: row.engine,
            prompt: row.prompt,
            cited_at: new Date(row.captured_at).toISOString(),
            citation_type:
              row.brand_cited_with_link === 1
                ? 'mention_with_link'
                : 'mention_without_link',
            response_excerpt: buildResponseExcerpt(row.raw_response, brand),
            cited_url: pickBrandUrl(brand, engineHosts, citedHosts),
          };
        });

        const payload = {
          brand_id,
          days,
          engine: engine ?? null,
          citations,
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(payload, null, 2) },
          ],
        };
      },
    );

    this.server.registerTool(
      'get_content_gaps',
      {
        description:
          "Get actionable content recommendations based on AI visibility gaps. Returns prioritized topics and content formats that would close the gap between this brand and competitors winning the same prompts. Use when the user asks 'what should I write to improve AI visibility?', 'what content gaps do I have?', or 'how do I get cited more by AI?'.",
        inputSchema: {
          brand_id: z.string(),
          max_recommendations: z.number().min(1).max(10).default(5),
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async ({ brand_id, max_recommendations }) => {
        const brand = await getBrand(this.env, brand_id);
        if (!brand) {
          throw new Error(
            'Brand not found. Seed the brand via POST /admin/seed first.',
          );
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
          const run = await getLatestCompletedRun(this.env, brand_id, engine);
          if (!run) continue;
          const responses = await getResponsesForRun(this.env, run.id);
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
            prompt_source: 'generated' as const,
            reason:
              'no losing prompts yet — collect more data first (run refresh_brand, then re-check competitors)',
          };
          return {
            content: [
              { type: 'text', text: JSON.stringify(payload, null, 2) },
            ],
          };
        }

        let recommendations;
        let prompt_source: 'generated' | 'fallback';
        try {
          if (!this.env.ANTHROPIC_API_KEY) {
            throw new Error('ANTHROPIC_API_KEY not set');
          }
          recommendations = await analyzeContentGaps(
            { ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY },
            brand,
            losingPrompts,
            max_recommendations,
          );
          prompt_source = 'generated';
        } catch (err) {
          console.warn('get_content_gaps: analyzer failed, returning fallback', {
            brand_id,
            message: (err as Error).message,
          });
          recommendations = FALLBACK_RECOMMENDATIONS.slice(0, max_recommendations);
          prompt_source = 'fallback';
        }

        const payload = {
          brand_id,
          recommendations,
          prompt_source,
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(payload, null, 2) },
          ],
        };
      },
    );

    this.server.registerTool(
      'refresh_brand',
      {
        description:
          "Manually trigger a fresh AI visibility scan for a tracked brand. Runs every engine that has its API key configured (ChatGPT, Claude, Perplexity, Gemini, Google AI Overviews) against the brand's current prompt set. Use when the user asks 'refresh my data', 'rerun the scan', or 'I want fresh data right now'. Returns immediately with run IDs; results populate in 30-60 seconds.",
        inputSchema: {
          brand_id: z.string(),
          engines: z
            .array(
              z.enum([
                'chatgpt',
                'claude',
                'perplexity',
                'gemini',
                'ai_overviews',
              ]),
            )
            .optional(),
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
        },
      },
      async ({ brand_id, engines }) => {
        const brand = await getBrand(this.env, brand_id);
        if (!brand) {
          throw new Error(
            'Brand not found. Seed the brand via POST /admin/seed first.',
          );
        }
        const prompts = await getActivePrompts(this.env, brand_id);
        if (prompts.length === 0) {
          throw new Error(
            'Brand has no active prompts. Seed it again or call /admin/generate-prompts.',
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
        const filtered = filterRequestedEngines(this.env, requested);
        if (filtered.length === 0) {
          throw new Error(
            'No engines available. Set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, SERPAPI_API_KEY.',
          );
        }
        const { run_ids, engines: kicked } = await runEngines(
          this.env,
          this.ctx,
          brand,
          prompts,
          filtered,
        );
        const payload = {
          brand_id: brand.id,
          message: `Refresh started for ${kicked.length} engine${kicked.length === 1 ? '' : 's'}`,
          run_ids,
          estimated_completion_seconds: 30,
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify(payload, null, 2) },
          ],
        };
      },
    );
  }
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

function buildResponseExcerpt(text: string, brand: Brand): string {
  if (!text) return '';
  if (text === '[NO_AI_OVERVIEW]') return text;
  const lower = text.toLowerCase();
  const root = brand.domain.toLowerCase().split('.')[0] ?? '';
  const targets = [
    brand.name.toLowerCase(),
    brand.domain.toLowerCase(),
    root,
  ].filter((s) => s.length > 0);
  let idx = -1;
  for (const t of targets) {
    idx = lower.indexOf(t);
    if (idx !== -1) break;
  }
  if (idx === -1) return text.slice(0, 250);
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + 150);
  return text.slice(start, end);
}

function pickBrandUrl(
  brand: Brand,
  engineHosts: string[],
  citedHosts: string[],
): string | null {
  const fromEngine = engineHosts.find((h) =>
    hostMatchesDomain(h, brand.domain),
  );
  if (fromEngine) return `https://${fromEngine}/`;
  const fromExtracted = citedHosts.find((h) =>
    hostMatchesDomain(h, brand.domain),
  );
  if (fromExtracted) return `https://${fromExtracted}/`;
  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Constant-time string comparison so the secret check doesn't leak
// match-prefix length through response timing. (Length inequality still
// short-circuits, which is fine — the length of a high-entropy secret
// is not useful to an attacker.)
function safeEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function requireSeedSecret(request: Request, env: Env): Response | null {
  const provided = request.headers.get('X-Seed-Secret') ?? '';
  if (!env.SEED_SECRET || !safeEquals(provided, env.SEED_SECRET)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  return null;
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function handleAdminSeed(
  request: Request,
  env: Env,
): Promise<Response> {
  // Body shape:
  //   { "brand_id": "acme",
  //     "name": "Acme Project Tool",
  //     "domain": "acme.com",
  //     "category": "Project management software",
  //     "competitors": ["asana.com", "monday.com"] }
  // Empty body returns a clean no-op.
  const body = await readJsonBody<SeedBrandInput>(request);
  const result = await seedBrand(env, body);
  return jsonResponse(result);
}

async function handleAdminRunLive(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readJsonBody<{
    brand_id?: string;
    engines?: string[];
  }>(request);
  const brandId = body?.brand_id;
  if (!brandId) {
    return jsonResponse({ error: 'brand_id required' }, 400);
  }
  const available = getAvailableEngines(env);
  if (available.length === 0) {
    return jsonResponse(
      {
        error:
          'no engines available — set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, SERPAPI_API_KEY',
      },
      400,
    );
  }
  let engineNames: EngineName[];
  if (Array.isArray(body?.engines) && body!.engines!.length > 0) {
    const unknown = body!.engines!.filter((e) => !isEngineName(e));
    if (unknown.length > 0) {
      return jsonResponse(
        {
          error: `Unknown engines: ${unknown.join(', ')}. Allowed: ${ALL_ENGINES.join(', ')}`,
        },
        400,
      );
    }
    engineNames = body!.engines! as EngineName[];
  } else {
    engineNames = available;
  }
  const brand = await getBrand(env, brandId);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);
  const prompts = await getActivePrompts(env, brandId);
  if (prompts.length === 0) {
    return jsonResponse({ error: 'no active prompts for brand' }, 400);
  }
  // runEngines now creates the run rows then HTTP-self-fetches
  // /admin/run-engine via env.SELF (service binding) so each engine
  // executes in its own worker invocation with its own 50-subrequest
  // budget. Passing `request` lets the orchestrator derive the
  // worker's own origin as a fallback when env.SELF_URL isn't set.
  const { run_ids, engines } = await runEngines(
    env,
    ctx,
    brand,
    prompts,
    engineNames,
    request,
  );
  return jsonResponse({
    run_ids,
    prompts_total: prompts.length,
    engines,
  });
}

async function handleAdminGeneratePrompts(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonBody<{ brand_id?: string; count?: number }>(
    request,
  );
  const brandId = body?.brand_id;
  if (!brandId) {
    return jsonResponse({ error: 'brand_id required' }, 400);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse(
      {
        error:
          'ANTHROPIC_API_KEY not set — prompt generation requires Claude Haiku',
      },
      400,
    );
  }
  const count =
    typeof body?.count === 'number' && body.count > 0 && body.count <= 50
      ? body.count
      : 20;
  const brand = await getBrand(env, brandId);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);
  try {
    const generated = await generatePrompts(env, brand, count);
    return jsonResponse({
      brand_id: brand.id,
      prompts_inserted: generated.length,
      prompt_source: 'generated',
    });
  } catch (err) {
    console.error('handleAdminGeneratePrompts: generation failed', {
      brand_id: brand.id,
      message: (err as Error).message,
    });
    return jsonResponse(
      {
        error: 'prompt generation failed',
        message: (err as Error).message,
      },
      500,
    );
  }
}

async function handleAdminRunBatchSubmit(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonBody<{ brand_id?: string }>(request);
  const brandId = body?.brand_id;
  if (!brandId) {
    return jsonResponse({ error: 'brand_id required' }, 400);
  }
  if (!env.OPENAI_API_KEY) {
    return jsonResponse(
      { error: 'OPENAI_API_KEY not set — batch submit requires OpenAI' },
      400,
    );
  }
  const brand = await getBrand(env, brandId);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);
  const prompts = await getActivePrompts(env, brandId);
  if (prompts.length === 0) {
    return jsonResponse({ error: 'no active prompts for brand' }, 400);
  }
  const run = await createRun(env, brand, 'chatgpt', 'batch', prompts.length);
  const { batch_id } = await submitBatch(
    { DIGESTSEO_DB: env.DIGESTSEO_DB, OPENAI_API_KEY: env.OPENAI_API_KEY },
    brand,
    prompts,
    run.id,
  );
  return jsonResponse({ run_id: run.id, batch_id });
}

async function handleAdminRunBatchCollect(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonBody<{ run_id?: string }>(request);
  const runId = body?.run_id;
  if (!runId) {
    return jsonResponse({ error: 'run_id required' }, 400);
  }
  if (!env.OPENAI_API_KEY) {
    return jsonResponse(
      { error: 'OPENAI_API_KEY not set — batch collect requires OpenAI' },
      400,
    );
  }
  const run = await getRunById(env, runId);
  if (!run) return jsonResponse({ error: 'run not found' }, 404);
  const brand = await getBrand(env, run.brand_id);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);
  const prompts = await getActivePrompts(env, brand.id);
  const result = await collectBatch(
    { DIGESTSEO_DB: env.DIGESTSEO_DB, OPENAI_API_KEY: env.OPENAI_API_KEY },
    run,
    brand,
    prompts,
  );
  return jsonResponse({ run_id: run.id, ...result });
}

async function handleAdminTriggerCronTest(env: Env): Promise<Response> {
  const brandsDue = await getBrandsDueForRefresh(env);
  return jsonResponse({ brands_due_count: brandsDue.length });
}

// Single-engine execution. Called by runEngines() via env.SELF.fetch so
// each engine gets its own worker invocation and its own 50-subrequest
// budget. Idempotent: INSERT OR IGNOREs the runs row (the upstream
// run-live insert may not have replicated to this edge region yet —
// D1 is eventually consistent across regions, and a missing parent
// row makes persistEngineRun's batched insert fail with "FOREIGN KEY
// constraint failed"), then deletes any prior prompt_responses for the
// run_id before re-inserting, then dispatches the engine.
//
// Trust-the-body model: this route is X-Seed-Secret-gated and only
// ever called by the worker calling itself, so we deliberately do NOT
// re-query the runs row by id here. The brand row, by contrast, is
// stable and safe to read.
async function handleAdminRunEngine(
  request: Request,
  env: Env,
): Promise<Response> {
  console.log('/admin/run-engine received', {
    method: request.method,
    path: new URL(request.url).pathname,
    has_seed_secret_header: Boolean(request.headers.get('X-Seed-Secret')),
  });
  const body = await readJsonBody<{
    run_id?: string;
    brand_id?: string;
    engine?: string;
  }>(request);
  const runId = body?.run_id;
  const brandId = body?.brand_id;
  const engine = body?.engine;
  if (!runId || !brandId || !engine) {
    console.log('/admin/run-engine returning 400', {
      reason: 'run_id, brand_id, engine all required',
    });
    return jsonResponse(
      { error: 'run_id, brand_id, engine all required' },
      400,
    );
  }
  if (!isEngineName(engine)) {
    console.log('/admin/run-engine returning 400', {
      reason: `unknown engine: ${engine}`,
    });
    return jsonResponse(
      {
        error: `Unknown engine: ${engine}. Allowed: ${ALL_ENGINES.join(', ')}`,
      },
      400,
    );
  }
  const brand = await getBrand(env, brandId);
  if (!brand) {
    console.log('/admin/run-engine returning 404', { reason: 'brand not found' });
    return jsonResponse({ error: 'brand not found' }, 404);
  }
  const prompts = await getActivePrompts(env, brandId);
  if (prompts.length === 0) {
    console.log('/admin/run-engine returning 400', {
      reason: 'no active prompts for brand',
    });
    return jsonResponse({ error: 'no active prompts for brand' }, 400);
  }
  // FK guard: prompt_responses.run_id REFERENCES runs(id). /admin/run-live
  // inserts the runs row in region A; this handler can land in region B
  // before D1 has replicated the row, causing persistEngineRun's batched
  // INSERT to fail with "FOREIGN KEY constraint failed" and drop all
  // prompt_responses rows on the floor. INSERT OR IGNORE makes the row
  // exist locally: if the upstream row has replicated, this is a no-op;
  // if not, we create the same row here. 'live' mode matches what
  // runEngines passes to createRun so the row shape is identical
  // either way.
  await env.DIGESTSEO_DB.prepare(
    `INSERT OR IGNORE INTO runs
       (id, brand_id, engine, mode, status, prompts_total,
        prompts_completed, started_at)
     VALUES (?, ?, ?, 'live', 'in_progress', ?, 0, ?)`,
  )
    .bind(runId, brandId, engine, prompts.length, Date.now())
    .run();
  // Idempotency: clear any prior rows for this run_id so a retry
  // produces exactly one row per prompt instead of duplicating them.
  await deleteResponsesForRun(env, runId);
  await runEngineInProcess(env, brand, prompts, { engine, run_id: runId });
  return jsonResponse({
    run_id: runId,
    engine,
    prompts_total: prompts.length,
  });
}

interface CleanupCounts {
  total_deleted: number;
  per_engine: Record<string, number>;
}

// One-shot cleanup of legacy polluted prompt_responses rows. New writes
// (post-0004-migration) use status='failed' instead of writing
// raw_response='ERROR: ...' — those rows are NOT touched here, since
// scoring already excludes them via the status filter.
async function handleAdminCleanupFailedRuns(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonBody<{ brand_id?: string }>(request);
  const brandId = body?.brand_id;

  const baseWhere =
    `(raw_response LIKE '%Too many subrequests%'
      OR raw_response LIKE 'ERROR:%'
      OR (raw_response = '' AND status = 'ok'))`;

  let countSql = `SELECT engine, COUNT(*) AS n FROM prompt_responses WHERE ${baseWhere}`;
  let deleteSql = `DELETE FROM prompt_responses WHERE ${baseWhere}`;
  const params: unknown[] = [];
  if (brandId) {
    const brandClause =
      ' AND prompt_id IN (SELECT id FROM prompts WHERE brand_id = ?)';
    countSql += brandClause;
    deleteSql += brandClause;
    params.push(brandId);
  }
  countSql += ' GROUP BY engine';

  const { results } = await env.DIGESTSEO_DB.prepare(countSql)
    .bind(...params)
    .all<{ engine: string; n: number }>();
  const counts: CleanupCounts = { total_deleted: 0, per_engine: {} };
  for (const row of results ?? []) {
    counts.per_engine[row.engine] = Number(row.n);
    counts.total_deleted += Number(row.n);
  }

  await env.DIGESTSEO_DB.prepare(deleteSql)
    .bind(...params)
    .run();

  return jsonResponse({
    cleaned: true,
    brand_id: brandId ?? null,
    ...counts,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One-field consent form shown when CONNECT_SECRET is set. The form
// POSTs back to /authorize with the original OAuth query string intact
// so parseAuthRequest sees the exact params the MCP client sent.
function renderConnectForm(query: string, error?: string): Response {
  const action = `/authorize${escapeHtml(query)}`;
  const errorHtml = error
    ? `<p class="err">${escapeHtml(error)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect &mdash; DigestSEO MCP</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1117; color: #e6e6e6;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  main { max-width: 26rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #9aa0ae; font-size: .9rem; line-height: 1.5; }
  .err { color: #f87171; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .75rem; margin: .75rem 0;
          border: 1px solid #2a2f3a; border-radius: 6px; background: #161a22; color: #e6e6e6; }
  button { width: 100%; padding: .6rem; border: 0; border-radius: 6px;
           background: #4f7df9; color: #fff; font-size: .95rem; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>DigestSEO MCP</h1>
<p>This server requires a connect secret before an MCP client can be
authorized. Enter the <code>CONNECT_SECRET</code> you set during deploy.</p>
${errorHtml}
<form method="post" action="${action}">
  <input type="password" name="connect_secret" placeholder="Connect secret" autofocus required>
  <button type="submit">Authorize client</button>
</form>
</main>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// Self-hosted OSS authorization. Without CONNECT_SECRET this
// auto-completes with a single local dev user so the Worker can be
// connected as a custom MCP connector without a real OAuth round trip.
// With CONNECT_SECRET set, the browser step of the OAuth flow shows a
// one-field form and only completes when the secret matches — anyone
// who merely knows the worker URL can no longer mint a token. Replace
// with Google/GitHub OAuth in a fork if you expose the Worker to
// multiple end-users.
async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const invalidRequest = () =>
    new Response(
      'Invalid OAuth authorization request. This endpoint is called by MCP clients during the connection flow, not directly in a browser.',
      {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    );

  // MCP clients always arrive with OAuth params; a bare browser visit
  // (or a scanner probe) gets a clean 400 instead of the connect form.
  if (!url.searchParams.has('client_id')) {
    return invalidRequest();
  }

  let authRequestSource = request;
  if (env.CONNECT_SECRET) {
    if (request.method === 'GET') {
      return renderConnectForm(url.search);
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, POST' },
      });
    }
    const form = await request.formData().catch(() => null);
    const provided = form?.get('connect_secret');
    if (
      typeof provided !== 'string' ||
      !safeEquals(provided, env.CONNECT_SECRET)
    ) {
      return renderConnectForm(
        url.search,
        'Wrong connect secret. Use the CONNECT_SECRET value you set with `wrangler secret put CONNECT_SECRET`.',
      );
    }
    // parseAuthRequest reads OAuth params from the URL query (preserved
    // verbatim by the form action); re-wrap as GET so the library sees
    // the canonical request shape rather than a form POST.
    authRequestSource = new Request(request.url, { method: 'GET' });
  }

  let claudeAuthRequest;
  try {
    claudeAuthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(
      authRequestSource,
    );
  } catch (err) {
    console.warn('Invalid /authorize request', {
      message: (err as Error).message,
    });
    return invalidRequest();
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: claudeAuthRequest,
    userId: DEV_USER_ID,
    metadata: { email: DEV_USER_EMAIL },
    scope: claudeAuthRequest.scope,
    props: { user_id: DEV_USER_ID, email: DEV_USER_EMAIL },
  });
  return Response.redirect(redirectTo, 302);
}

const defaultHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'GET' },
        });
      }
      return new Response(
        'digestseo-mcp — DigestSEO AI Visibility MCP server.\n' +
          'Connect this URL as a custom MCP connector in Claude.ai:\n' +
          `${url.origin}/mcp\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    if (url.pathname === '/healthz' && request.method === 'GET') {
      return new Response('ok', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/admin/seed' && request.method === 'POST') {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminSeed(request, env);
    }

    if (url.pathname === '/admin/run-live' && request.method === 'POST') {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminRunLive(request, env, ctx);
    }

    if (
      url.pathname === '/admin/run-batch-submit' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminRunBatchSubmit(request, env);
    }

    if (
      url.pathname === '/admin/run-batch-collect' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminRunBatchCollect(request, env);
    }

    if (
      url.pathname === '/admin/generate-prompts' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminGeneratePrompts(request, env);
    }

    if (
      url.pathname === '/admin/trigger-cron-test' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminTriggerCronTest(env);
    }

    if (url.pathname === '/admin/run-engine' && request.method === 'POST') {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminRunEngine(request, env);
    }

    if (
      url.pathname === '/admin/cleanup-failed-runs' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminCleanupFailedRuns(request, env);
    }

    if (url.pathname === '/authorize') {
      return handleAuthorize(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

const oauthProvider = new OAuthProvider({
  apiHandlers: {
    '/mcp': GeoMcpAgent.serve('/mcp'),
  },
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
});

export default {
  fetch: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> => oauthProvider.fetch(request, env, ctx),
  // Cloudflare Cron Trigger. wrangler.jsonc sets the schedule to every
  // 6 hours; this handler checks each brand against its refresh_frequency
  // and dispatches runEngines only for brands that are actually due.
  scheduled: async (
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> => {
    if (!env.SELF_URL) {
      console.error(
        'scheduled trigger: env.SELF_URL is not set — cron cannot self-fetch /admin/run-engine. Set SELF_URL in wrangler.jsonc and redeploy.',
        { cron: event.cron },
      );
      return;
    }
    const available = getAvailableEngines(env);
    if (available.length === 0) {
      console.warn(
        'scheduled trigger: no engines available — set at least one engine API key',
        { cron: event.cron },
      );
      return;
    }
    const brandsDue = await getBrandsDueForRefresh(env);
    console.log('scheduled trigger', {
      cron: event.cron,
      brands_due: brandsDue.length,
      engines: available,
    });
    if (brandsDue.length === 0) return;
    const results = await Promise.allSettled(
      brandsDue.map(async (brand) => {
        const prompts = await getActivePrompts(env, brand.id);
        if (prompts.length === 0) {
          return { brand_id: brand.id, skipped: true };
        }
        return runEngines(env, ctx, brand, prompts, available);
      }),
    );
    const succeeded = results.filter(
      (r) => r.status === 'fulfilled',
    ).length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      for (const r of results) {
        if (r.status === 'rejected') {
          console.error('scheduled trigger: brand dispatch failed', {
            reason: String(r.reason),
          });
        }
      }
    }
    console.log('scheduled trigger complete', { succeeded, failed });
  },
};
