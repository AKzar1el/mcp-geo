// The six MCP tools, registered against any McpServer. Shared verbatim
// between the Cloudflare Worker (src/index.ts) and the local stdio CLI
// (src/cli.ts) — only the Deps wiring differs:
//   - Worker: D1-backed Db, refresh_brand fans out per engine via the
//     SELF service binding (50-subrequest budget per invocation).
//   - CLI: sqlite-backed Db, refresh_brand runs engines inline and
//     sequentially (no subrequest budget locally).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Brand, Db, Prompt, PromptResponse } from '../db/types.js';
import {
  ALL_ENGINES,
  getAvailableEngines,
  isEngineName,
  type EngineKeys,
  type EngineName,
  type RunEnginesResult,
} from './engines.js';
import {
  analyzeContentGaps,
  FALLBACK_RECOMMENDATIONS,
  type LosingPromptSummary,
} from './content-gap-analysis.js';
import { computeOverallScore } from './scoring.js';
import { generatePrompts } from './prompt-generation.js';
import { seedBrand } from './seed.js';

const BRAND_NOT_FOUND_MESSAGE =
  'Brand not found. Create it first: use the track_brand tool (local CLI), or POST /admin/seed on a Cloudflare Workers deployment.';

export interface Deps {
  db: Db;
  env: EngineKeys;
  // Kicks off one run per engine and returns the run ids. The Worker
  // implementation dispatches each engine into its own invocation via
  // the SELF service binding and returns immediately; the CLI
  // implementation runs each engine to completion before returning.
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
  return requested.filter((e) => available.has(e));
}

export function registerTools(server: McpServer, deps: Deps): void {
  server.registerTool(
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
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }

      // getLatestCompletedRun anchors on EXISTS(ok rows) rather than
      // run.status='completed', so partially-finished runs (killed
      // by the subrequest cap, wall time, etc.) still surface their
      // ok rows. Use completed_at when available, started_at as a
      // fallback for in-progress runs.
      const allResponses: PromptResponse[] = [];
      let mostRecentTimestamp = 0;
      for (const engine of ALL_ENGINES) {
        const run = await deps.db.getLatestCompletedRun(brand_id, engine);
        if (!run) continue;
        const responses = await deps.db.getResponsesForRun(run.id);
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

  server.registerTool(
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
      const results = await deps.db.getVisibilityHistoryRows(brand_id, since);

      const buckets = new Map<string, Map<string, number>>();
      for (const row of results) {
        const date = bucketStart(row.completed_at, granularity);
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

  server.registerTool(
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
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
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
        const run = await deps.db.getLatestCompletedRun(brand_id, engine);
        if (!run) continue;
        const ts = run.completed_at ?? run.started_at;
        if (ts < since) continue;
        const responses = await deps.db.getResponsesForRun(run.id);
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

  server.registerTool(
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
      const brand = await deps.db.getBrand(brand_id);
      if (!brand) {
        throw new Error(BRAND_NOT_FOUND_MESSAGE);
      }
      const since = Date.now() - days * 86_400_000;
      const results = await deps.db.getCitationRows(brand_id, since, engine);

      const citations = results.map((row) => {
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

  server.registerTool(
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
        if (!deps.env.ANTHROPIC_API_KEY) {
          throw new Error('ANTHROPIC_API_KEY not set');
        }
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

  server.registerTool(
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
      if (filtered.length === 0) {
        throw new Error(
          'No engines available. Set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, SERPAPI_API_KEY.',
        );
      }
      const { run_ids, engines: kicked } = await deps.runEnginesInline(
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

export interface ManagementDeps {
  db: Db;
  env: EngineKeys;
}

// Local brand-management tools, registered ONLY by the stdio CLI
// (src/cli.ts). The Worker deliberately does not expose these over MCP:
// on a hosted deployment, brand creation and prompt regeneration stay
// behind the X-Seed-Secret-gated /admin/* routes, while the OSS
// Worker's OAuth flow auto-approves any connector.
export function registerLocalManagementTools(
  server: McpServer,
  deps: ManagementDeps,
): void {
  server.registerTool(
    'track_brand',
    {
      description:
        "Start tracking a brand's AI visibility. Creates the brand in the local database and generates buyer-intent prompts for it — via Claude Haiku when ANTHROPIC_API_KEY is configured, otherwise three generic starter prompts (upgrade later with generate_prompts). Use when the user says 'track my brand', 'add my site', 'start monitoring acme.com', or when another tool reported the brand doesn't exist. After tracking, call refresh_brand to run the first scan.",
      inputSchema: {
        brand_id: z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9_-]{0,63}$/i,
            'brand_id must be 1-64 characters: letters, digits, hyphens, underscores (e.g. "acme")',
          ),
        name: z.string().min(1).max(200),
        domain: z.string().min(3).max(253),
        category: z.string().min(1).max(200).optional(),
        competitors: z.array(z.string().min(3).max(253)).max(20).optional(),
        prompt_count: z.number().int().min(1).max(50).default(20),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ brand_id, name, domain, category, competitors, prompt_count }) => {
      const normalizedDomain = normalizeDomainInput(domain);
      if (!normalizedDomain) {
        throw new Error(
          `'${domain}' does not look like a domain. Pass a bare domain like 'acme.com' (no scheme or path needed).`,
        );
      }
      const normalizedCompetitors: string[] = [];
      for (const raw of competitors ?? []) {
        const host = normalizeDomainInput(raw);
        if (!host) {
          throw new Error(
            `Competitor '${raw}' does not look like a domain. Pass bare domains like 'asana.com'.`,
          );
        }
        if (host === normalizedDomain) continue;
        if (!normalizedCompetitors.includes(host)) {
          normalizedCompetitors.push(host);
        }
      }

      const result = await seedBrand(
        { db: deps.db, ANTHROPIC_API_KEY: deps.env.ANTHROPIC_API_KEY },
        {
          brand_id,
          name,
          domain: normalizedDomain,
          category,
          competitors: normalizedCompetitors,
        },
        prompt_count,
      );

      let next_steps: string;
      if (result.seeded) {
        next_steps =
          result.prompt_source === 'fallback'
            ? `Tracked with ${result.prompts_inserted} generic starter prompts (no ANTHROPIC_API_KEY configured for prompt generation). Call refresh_brand with brand_id '${result.brand_id}' to run the first scan; add ANTHROPIC_API_KEY and call generate_prompts later for category-specific prompts.`
            : `Call refresh_brand with brand_id '${result.brand_id}' to run the first scan, then check_visibility for the results.`;
      } else if (result.reason === 'already exists') {
        next_steps = `Brand '${result.brand_id}' is already tracked — nothing was changed. Use list_brands to inspect it, generate_prompts to refresh its prompt set, or pick a different brand_id.`;
      } else {
        next_steps =
          'Nothing was created — brand_id, name, and domain are all required.';
      }

      const payload = {
        ...result,
        domain: result.seeded ? normalizedDomain : undefined,
        competitors: result.seeded ? normalizedCompetitors : undefined,
        next_steps,
      };
      return {
        content: [
          { type: 'text', text: JSON.stringify(payload, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    'list_brands',
    {
      description:
        "List every brand tracked in the local database, with domain, category, competitors, refresh frequency, and how many prompts are active. Use when the user asks 'which brands am I tracking?' or to look up the brand_id the other tools need.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
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
          refresh_frequency: b.refresh_frequency,
          active_prompts: b.active_prompts,
          created_at: new Date(b.created_at).toISOString(),
        })),
        hint:
          brands.length === 0
            ? 'No brands tracked yet — call track_brand to add one.'
            : undefined,
      };
      return {
        content: [
          { type: 'text', text: JSON.stringify(payload, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    'generate_prompts',
    {
      description:
        "Regenerate the buyer-intent prompt set for a tracked brand using Claude Haiku (requires ANTHROPIC_API_KEY). Replaces the brand's active prompts; historical run data is preserved. Use when the user wants better or more prompts, or to upgrade from the generic starter prompts after adding an Anthropic key.",
      inputSchema: {
        brand_id: z.string(),
        count: z.number().int().min(1).max(50).default(20),
      },
      annotations: {
        readOnlyHint: false,
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
      return {
        content: [
          { type: 'text', text: JSON.stringify(payload, null, 2) },
        ],
      };
    },
  );
}

// 'https://www.Acme.com/pricing?x=1' → 'acme.com'. Returns null when
// the input doesn't reduce to something domain-shaped. Citation
// matching compares lowercased hostnames with their www. prefix
// stripped (see core/openai.ts normalizeHost), so storing the brand
// domain in that same shape is what makes brand_cited_with_link work.
function normalizeDomainInput(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split('/')[0] ?? s; // path
  s = s.split('?')[0] ?? s; // query without a path
  s = s.split('#')[0] ?? s; // fragment without a path
  s = s.replace(/:\d+$/, ''); // port
  if (s.startsWith('www.')) s = s.slice(4);
  if (s.length === 0 || s.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    return null;
  }
  return s;
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
  const fullDomain = brand.domain.toLowerCase();
  const fromEngine = engineHosts.find((h) => h.includes(fullDomain));
  if (fromEngine) return `https://${fromEngine}/`;
  const fromExtracted = citedHosts.find((h) => h.includes(fullDomain));
  if (fromExtracted) return `https://${fromExtracted}/`;
  return null;
}
