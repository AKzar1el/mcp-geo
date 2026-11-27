// GEO report in the jev-seo report model (shoper-growth-mcp decision 19):
// the same top-level shape as jev-seo audit.json (schema_version, tool, run,
// site, scores, actions), so one importer reads both. Actions carry GEO-###
// IDs, priority P1-P3, impact, effort, evidence, fix, source and a to_verify
// flag; scores state their method and are never traffic predictions; AI
// visibility is a rate with n answers, runs, window, engine and market.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Brand, Db, PromptResponse } from '../db/types.js';
import { ALL_ENGINES } from './engines.js';
import { brandMarket } from './market.js';
import { findTermSetMatchIndex } from './openai.js';
import { auditSite, MAX_CRAWL_LIMIT, type SiteCheck } from './site-audit.js';

type Severity = 'critical' | 'high' | 'medium' | 'low';
// Same weights and priority rules as jev-seo (jevseo/checks.py, score.py).
const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, high: 6, medium: 3, low: 1 };

const G = 'https://developers.google.com/search/docs';
const HEADINGS = 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements';
const SD = `${G}/appearance/structured-data/intro-structured-data`;

type Rule = { category: string; severity: Severity; effort: number; title: string; fix: string; source: string; heuristic?: boolean };

// One rule per AEO check. llms-txt has none: it weighs 0 (decision 18).
export const CHECK_RULES: Record<string, Rule> = {
  'ai-bot-access': { category: 'crawl', severity: 'critical', effort: 1, title: 'AI crawlers blocked in robots.txt',
    fix: 'Allow GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot and Google-Extended in robots.txt.',
    source: 'https://platform.openai.com/docs/bots' },
  indexability: { category: 'crawl', severity: 'high', effort: 1, title: 'Pages marked noindex',
    fix: 'Remove noindex from pages meant to be found; keep it on login, basket and account pages.',
    source: `${G}/crawling-indexing/block-indexing` },
  'ai-meta-tags': { category: 'crawl', severity: 'high', effort: 1, title: 'Pages block AI snippets (nosnippet, noai)',
    fix: 'Drop nosnippet, noai and noimageai from the robots meta tag on pages that should be quoted.',
    source: `${G}/crawling-indexing/robots-meta-tag` },
  title: { category: 'onpage', severity: 'medium', effort: 1, title: 'Missing or too short page titles',
    fix: 'Write a descriptive title of at least 10 characters naming the page topic.',
    source: `${G}/appearance/title-link` },
  'meta-description': { category: 'onpage', severity: 'medium', effort: 1, title: 'Missing or too short meta descriptions',
    fix: 'Write a meta description of 50+ characters that summarises the page.',
    source: `${G}/appearance/snippet` },
  canonical: { category: 'crawl', severity: 'low', effort: 1, title: 'Pages without a canonical URL',
    fix: 'Add a rel=canonical link pointing at the preferred URL.',
    source: `${G}/crawling-indexing/consolidate-duplicate-urls` },
  h1: { category: 'structure', severity: 'low', effort: 1, title: 'Pages without exactly one H1',
    fix: 'Give each page one H1 naming its topic (theme template on most platforms).', source: HEADINGS },
  'heading-hierarchy': { category: 'structure', severity: 'low', effort: 1, title: 'Flat or skipped heading outline',
    fix: 'Use H2/H3 subheadings in order, without skipping levels.', source: HEADINGS },
  schema: { category: 'structured', severity: 'medium', effort: 2, title: 'Pages without JSON-LD structured data',
    fix: 'Add JSON-LD (Product, Organization, BreadcrumbList, Article) matching the page.', source: SD },
  'schema-types': { category: 'structured', severity: 'medium', effort: 2, title: 'JSON-LD without a recognised schema type',
    fix: 'Use a schema.org type AI engines and Google understand (Product, Organization, Article, FAQPage, BreadcrumbList).', source: SD },
  og: { category: 'structured', severity: 'low', effort: 1, title: 'Missing Open Graph title or description',
    fix: 'Add og:title and og:description to every page.', source: 'https://ogp.me/' },
  'internal-links': { category: 'links', severity: 'low', effort: 2, title: 'Pages with fewer than 5 internal links',
    fix: 'Link to related categories, products and guides from the page body.',
    source: `${G}/crawling-indexing/links-crawlable` },
  'image-alt': { category: 'content', severity: 'low', effort: 1, title: 'Images without alt text',
    fix: 'Describe each meaningful image in its alt attribute (product: title, format, what is shown).',
    source: `${G}/appearance/google-images` },
  'text-depth': { category: 'content', severity: 'medium', effort: 3, title: 'Thin pages (under 250 words)',
    fix: 'Add the substance a buyer asks AI about: who it is for, specifics, answers to common questions.',
    source: `${G}/fundamentals/creating-helpful-content`, heuristic: true },
  'rss-feed': { category: 'discovery', severity: 'low', effort: 2, title: 'No RSS or Atom feed',
    fix: 'Publish a feed for the blog or news section and link it with <link rel="alternate">.',
    source: 'https://www.rssboard.org/rss-specification', heuristic: true },
};

const VISIBILITY_SOURCE = 'https://github.com/AKzar1el/mcp-geo/blob/main/docs/ai-visibility-audit-methodology.md';
// Fewer answers than this per report = a rate too noisy to act on without a rerun.
export const MIN_ANSWERS = 20;

export type Action = {
  action_id: string;
  id: string;
  origin: 'aeo' | 'visibility';
  category: string;
  severity: Severity;
  priority: 'P1' | 'P2' | 'P3';
  impact: number;
  effort: number;
  quick_win: boolean;
  title: string;
  fix: string;
  source: string;
  count: number;
  evidence: string;
  heuristic: boolean;
  to_verify: boolean;
  urls: string[];
  prompts?: string[];
  status: 'to_do';
};

type Draft = Omit<Action, 'action_id' | 'priority' | 'impact' | 'quick_win' | 'status'> & { reach: number };

export type EngineVisibility = { engine: string; run_id: string; mentioned: number; answers: number; rate: number };
export type Visibility = {
  rate: number | null;
  mentioned: number;
  answers: number;
  runs: number;
  window: { from: string; to: string } | null;
  market: string;
  google_domain: string;
  branded_prompts_excluded: number;
  per_engine: EngineVisibility[];
};

type Audit = Awaited<ReturnType<typeof auditSite>>;

function aeoDrafts(audit: Audit): Draft[] {
  const out: Draft[] = [];
  for (const c of audit.checks as SiteCheck[]) {
    const rule = CHECK_RULES[c.id];
    if (!rule || c.failingUrls.length === 0) continue;
    const robotsUnknown = c.id === 'ai-bot-access' && !!audit.robots.error;
    const perPage = !['ai-bot-access', 'rss-feed'].includes(c.id);
    out.push({
      id: c.id, origin: 'aeo', category: rule.category,
      // A check that passes site-wide (80%+) still lists its failing pages, one level lower.
      severity: robotsUnknown ? 'high' : c.passed ? lower(rule.severity) : rule.severity,
      effort: rule.effort, title: rule.title, fix: rule.fix, source: rule.source,
      count: c.failingUrls.length,
      evidence: perPage ? `${c.details} ${c.label} failed on ${c.failingUrls.length} of ${audit.crawledPages} crawled pages.` : c.details,
      heuristic: !!rule.heuristic,
      // noindex is often intended (login, basket): a person confirms which pages should be indexed.
      to_verify: !!rule.heuristic || robotsUnknown || c.id === 'indexability',
      urls: c.failingUrls,
      reach: perPage ? c.failingUrls.length / Math.max(1, audit.crawledPages) : 1,
    });
  }
  return out;
}

const lower = (s: Severity): Severity => (s === 'critical' ? 'high' : s === 'high' ? 'medium' : 'low');

function visibilityDrafts({ visibility: v, losing, absent, promptCount }: VisibilitySummary): Draft[] {
  if (v.rate === null) return [];
  const out: Draft[] = [];
  const to_verify = v.answers < MIN_ANSWERS;
  const engines = v.per_engine.map((e) => `${e.engine} ${e.mentioned}/${e.answers}`).join(', ');
  const sample = `${v.answers} unbranded answers, ${v.runs} runs, ${v.window?.from.slice(0, 10)} to ${v.window?.to.slice(0, 10)}, market ${v.market}`;
  if (v.rate < 0.3 && absent.length > 0) {
    out.push({
      id: 'ai_visibility_low', origin: 'visibility', category: 'visibility',
      severity: v.rate < 0.1 ? 'high' : 'medium', effort: 3,
      title: 'Brand missing from AI answers to buyer questions',
      fix: 'Publish pages that answer these questions directly (category texts, buyer Q&A, specs) and rescan the same prompts after the change.',
      source: VISIBILITY_SOURCE, count: absent.length,
      evidence: `Mentioned in ${v.mentioned} of ${v.answers} answers (${Math.round(v.rate * 100)} %; ${engines}); ${absent.length} prompts with no mention on any engine. Sample: ${sample}.`,
      heuristic: false, to_verify, urls: [], prompts: absent, reach: absent.length / promptCount,
    });
  }
  if (losing.length > 0) {
    const counts = new Map<string, number>();
    for (const l of losing) for (const c of l.competitors) counts.set(c, (counts.get(c) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([c, n]) => `${c} (${n})`);
    out.push({
      id: 'competitors_preferred', origin: 'visibility', category: 'visibility', severity: 'medium', effort: 3,
      title: 'AI engines name competitors instead of the brand',
      fix: 'Compare the cited competitor pages with yours (get_content_gaps) and close the gaps on the matching category and product pages.',
      source: VISIBILITY_SOURCE, count: losing.length,
      evidence: `${losing.length} prompts where an answer names a competitor but not the brand. Most named: ${top.join(', ')}. Sample: ${sample}.`,
      heuristic: false, to_verify, urls: [], prompts: losing.map((l) => l.prompt), reach: losing.length / promptCount,
    });
  }
  return out;
}

/** jev-seo rules: impact normalised to the top action = 100; P1 critical or high with impact 40+. */
export function rankActions(drafts: Draft[]): Action[] {
  const raw = drafts.map((d) => SEVERITY_WEIGHT[d.severity] * (0.6 + 0.4 * d.reach));
  const top = Math.max(1, ...raw);
  const ranked = drafts.map(({ reach: _reach, ...d }, i) => {
    const impact = Math.round((100 * raw[i]) / top);
    const priority: Action['priority'] = d.severity === 'critical' || (d.severity === 'high' && impact >= 40) ? 'P1'
      : impact >= 30 || d.severity === 'high' ? 'P2' : 'P3';
    return { ...d, priority, impact, quick_win: impact >= 35 && d.effort <= 1 };
  });
  ranked.sort((a, b) => a.priority.localeCompare(b.priority) || b.impact - a.impact || a.effort - b.effort || a.id.localeCompare(b.id));
  return ranked.map((a, i) => ({ action_id: `GEO-${String(i + 1).padStart(3, '0')}`, ...a, status: 'to_do' as const }));
}

/**
 * Unbranded AI visibility from the latest completed run per engine in the
 * brand's current market. Prompts naming the brand are left out (they measure
 * recall, not discovery); runs started before an identity change are skipped.
 */
export function summariseVisibility(brand: Brand, runs: { run_id: string; started_at: number; responses: PromptResponse[] }[]) {
  const market = brandMarket(brand);
  // Aliases count: 'Studio Koloru czy Dwie Siostry' names the brand without its full name.
  const names = (text: string) => findTermSetMatchIndex(text, { domain: brand.domain, name: brand.name, aliases: brand.aliases, excludeTerms: [] }) !== -1;
  const branded = new Set<string>();
  const latest = new Map<string, PromptResponse & { run_id: string }>(); // engine+prompt -> newest ok row
  const usedRuns = new Set<string>();
  for (const run of runs) {
    if (brand.identity_changed_at && run.started_at < brand.identity_changed_at) continue;
    for (const r of run.responses) {
      if (r.status !== 'ok') continue;
      if (names(r.prompt_text)) { branded.add(r.prompt_id); continue; }
      const key = `${r.engine}\u0000${r.prompt_id}`;
      const prev = latest.get(key);
      if (!prev || r.captured_at > prev.captured_at) latest.set(key, { ...r, run_id: run.run_id });
      usedRuns.add(run.run_id);
    }
  }
  const rows = [...latest.values()];
  const per_engine: EngineVisibility[] = [...new Set(rows.map((r) => r.engine))].sort().map((engine) => {
    const e = rows.filter((r) => r.engine === engine);
    const mentioned = e.filter((r) => r.brand_mentioned === 1).length;
    return { engine, run_id: e[0].run_id, mentioned, answers: e.length, rate: Math.round((1000 * mentioned) / e.length) / 1000 };
  });
  const mentioned = rows.filter((r) => r.brand_mentioned === 1).length;
  const times = rows.map((r) => r.captured_at).sort((a, b) => a - b);
  const visibility: Visibility = {
    rate: rows.length ? Math.round((1000 * mentioned) / rows.length) / 1000 : null,
    mentioned, answers: rows.length, runs: usedRuns.size,
    window: times.length ? { from: new Date(times[0]).toISOString(), to: new Date(times[times.length - 1]).toISOString() } : null,
    market: market.market, google_domain: market.google_domain,
    branded_prompts_excluded: branded.size, per_engine,
  };
  const byPrompt = new Map<string, { prompt: string; hit: boolean; competitors: Set<string> }>();
  for (const r of rows) {
    const p = byPrompt.get(r.prompt_id) ?? { prompt: r.prompt_text, hit: false, competitors: new Set<string>() };
    if (r.brand_mentioned === 1) p.hit = true;
    else for (const c of r.competitors_mentioned) p.competitors.add(c);
    byPrompt.set(r.prompt_id, p);
  }
  const prompts = [...byPrompt.values()].sort((a, b) => a.prompt.localeCompare(b.prompt));
  const absent = prompts.filter((p) => !p.hit).map((p) => p.prompt);
  const losing = prompts.filter((p) => p.competitors.size > 0).map((p) => ({ prompt: p.prompt, competitors: [...p.competitors].sort() }));
  return { visibility, absent, losing, promptCount: prompts.length };
}
export type VisibilitySummary = ReturnType<typeof summariseVisibility>;

export function buildGeoReport(brand: Brand, audit: Audit, vis: VisibilitySummary, version: string) {
  const { visibility } = vis;
  const actions = rankActions([...aeoDrafts(audit), ...visibilityDrafts(vis)]);
  return {
    schema_version: '1.0',
    tool: { name: 'mlw-geo', version },
    run: { generated_at: audit.generatedAt, options: { brand_id: brand.id, max_pages: audit.maxPages }, crawl_ms: audit.diagnostics.crawlMs },
    site: { domain: brand.domain, url: audit.url, market: visibility.market, google_domain: visibility.google_domain,
      crawled_pages: audit.crawledPages, page_types: audit.pageTypes, robots: audit.robots, llms_txt: audit.llmsTxt },
    scores: {
      categories: { aeo: audit.foundationalScore, ai_visibility: visibility.rate === null ? null : Math.round(visibility.rate * 100) },
      category_names: { aeo: 'AI search foundations (site audit)', ai_visibility: 'AI visibility on buyer prompts' },
      notes: {
        aeo: `16 deterministic checks on ${audit.crawledPages} crawled pages; a site-wide check passes when 80%+ of pages pass it; llms.txt weighs 0. Ranks work, not a traffic prediction. Content quality (6 dimensions) is scored by the calling model from pages_for_review, not here.`,
        ai_visibility: visibility.rate === null
          ? `Not assessed: no completed scan in market ${visibility.market}. Run refresh_brand, then rebuild the report.`
          : `Share of unbranded answers that mention the brand: ${visibility.mentioned}/${visibility.answers}, latest completed run per engine (n = ${visibility.runs} runs), ${visibility.window!.from.slice(0, 10)} to ${visibility.window!.to.slice(0, 10)}, market ${visibility.market} (${visibility.google_domain}). ${visibility.branded_prompts_excluded} prompts naming the brand left out. A sample, not a ranking or traffic prediction.${visibility.answers < MIN_ANSWERS ? ` Under ${MIN_ANSWERS} answers: to verify with a rerun.` : ''}`,
      },
      // Not combined into one overall: a site audit and sampled AI answers do not share a scale.
      overall: null,
    },
    visibility,
    actions,
    pages_for_review: audit.pagesForReview,
  };
}

export async function collectRuns(db: Db, brandId: string) {
  const out: { run_id: string; started_at: number; responses: PromptResponse[] }[] = [];
  for (const engine of ALL_ENGINES) {
    const run = await db.getLatestCompletedRun(brandId, engine);
    if (run) out.push({ run_id: run.id, started_at: run.started_at, responses: await db.getResponsesForRun(run.id) });
  }
  return out;
}

export function registerGeoReportTool(server: McpServer, db: Db, f: typeof fetch, version: string): void {
  server.registerTool(
    'geo.report',
    {
      title: 'GEO report (jev-seo model)',
      description:
        "Build the GEO report for a tracked brand in the jev-seo report model: runs the AEO site audit and reads the latest stored AI visibility scan (no new engine calls). Returns scores with their method, AI visibility as a rate with n answers, runs, window and market, and GEO-### actions (priority, impact, effort, evidence, fix, source, to_verify). Example: brand_id='studiokoloru'.",
      inputSchema: {
        brand_id: z.string().describe('Tracked brand ID.'),
        max_pages: z.number().int().min(1).max(MAX_CRAWL_LIMIT).optional().describe('Pages to crawl, default 30.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ brand_id, max_pages }) => {
      const brand = await db.getBrand(brand_id);
      if (!brand) throw new Error(`Unknown brand_id '${brand_id}'. Call list_brands for tracked IDs.`);
      const [audit, runs] = await Promise.all([auditSite(f, brand.domain, max_pages ?? MAX_CRAWL_LIMIT), collectRuns(db, brand_id)]);
      const payload = buildGeoReport(brand, audit, summariseVisibility(brand, runs), version);
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );
}
