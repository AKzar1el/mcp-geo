// Deterministic AEO site audit, ported from gtm-engineer-skills
// audit-website-aeo/scripts/aeo-audit.mjs (MIT, OnVoyage). Crawls the brand's
// own site the way an AI agent would (robots.txt + sitemap + internal links)
// and runs the 16 checks. Changes from the reference:
// - llms.txt is reported but carries 0 points (no AI engine reads it), so the
//   foundational score is out of 132, not 142;
// - robots.txt groups (several User-agent lines sharing rules) are parsed per
//   spec, and an AI bot with no group of its own inherits `User-agent: *`;
// - fetch is injected so the Worker can route through the Shoper egress proxy;
// - the heuristic intelligence prior and fix list are dropped: the calling
//   model scores the 6 content dimensions from pagesForReview, and GEO-###
//   actions come from the jev-seo report model.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../db/types.js';
import { EgressError } from './egress.js';

const AI_BOT_AGENTS = [
  'gptbot', 'claudebot', 'perplexitybot', 'google-extended',
  'oai-searchbot', 'anthropic-ai', 'chatgpt-user', 'bytespider', 'ccbot',
];
const RECOGNIZED_SCHEMA_TYPES = [
  'Organization', 'WebSite', 'WebPage', 'Article', 'Product', 'FAQPage',
  'BreadcrumbList', 'LocalBusiness', 'Person', 'Event', 'HowTo', 'Recipe',
  'VideoObject', 'SoftwareApplication',
];
export const MAX_CRAWL_LIMIT = 30;
const MAX_HTML_BYTES = 512_000;
const FETCH_TIMEOUT_MS = 12_000;
const CRAWL_CONCURRENCY = 5;
const MAX_SITEMAPS = 12;
const UA = 'Mozilla/5.0 (compatible; AEOAuditBot/1.0; +https://github.com/onvoyage-ai/gtm-engineer-skills)';

const collapse = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
const scoreToInt = (v: number) => Math.round(Math.min(100, Math.max(0, v)));

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

// ─── HTML parsing (regex, no DOM) ────────────────────────────────────────────

type Attrs = Record<string, string>;
function parseAttrs(tagInner: string): Attrs {
  const attrs: Attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let m;
  while ((m = re.exec(tagInner))) {
    let val = m[2] ?? '';
    if (val && (val[0] === '"' || val[0] === "'")) val = val.slice(1, -1);
    attrs[m[1].toLowerCase()] = decodeEntities(val);
  }
  return attrs;
}
const findOpenTags = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map((m) => parseAttrs(m[1]));
const firstInner = (html: string, tag: string) =>
  html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] ?? '';
const allInner = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((m) => m[1]);
const stripTags = (s: string) => (s || '').replace(/<[^>]+>/g, ' ');

function dropTags(html: string, tags: string[]): string {
  let s = (html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of tags) s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  return s;
}
const visibleText = (html: string) => collapse(decodeEntities(stripTags(dropTags(html, ['script', 'style', 'noscript']))));
function contentExcerpt(bodyInner: string): string {
  const s = dropTags(bodyInner, ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'iframe', 'svg', 'form']);
  const main = firstInner(s, 'main') || firstInner(s, 'article');
  return collapse(decodeEntities(stripTags(main || s))).slice(0, 2000);
}

// ─── URLs and robots.txt ─────────────────────────────────────────────────────

// Apex and www are one site: Shoper redirects www.studiokoloru.eu to the apex.
const siteHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

function cleanUrl(u: URL): string {
  u.hash = '';
  u.search = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}
const shouldSkipPath = (p: string) =>
  /\.(pdf|jpg|jpeg|png|gif|webp|svg|ico|zip|rar|7z|mp4|mp3|mov|avi|woff2?|ttf|eot|css|js)$/i.test(p);

type PathRules = { allow: string[]; disallow: string[] };
export type RobotsPolicy = PathRules & { sitemapUrls: string[]; found: boolean; aiBotBlocked: string[] };

function ruleMatches(pathname: string, rule: string): boolean {
  const pattern = rule.trim().replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return pattern !== '' && new RegExp(`^${pattern}`).test(pathname);
}
export function isPathAllowed(pathname: string, rules: PathRules): boolean {
  const best = (list: string[]) => Math.max(-1, ...list.filter((r) => ruleMatches(pathname, r)).map((r) => r.length));
  const allow = best(rules.allow);
  const disallow = best(rules.disallow);
  return disallow === -1 || allow >= disallow;
}

export function parseRobots(txt: string, robotsUrl: string): RobotsPolicy {
  const groups = new Map<string, PathRules>();
  const sitemaps = new Set<string>();
  let group: string[] = [];
  let inRules = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/\s*#.*$/, '').trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (inRules) { group = []; inRules = false; }
      group.push(value.toLowerCase());
    } else if (key === 'sitemap') {
      try {
        const sm = new URL(value, robotsUrl);
        if (siteHost(sm.host) === siteHost(new URL(robotsUrl).host)) sitemaps.add(sm.toString());
      } catch { /* malformed */ }
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (!value) continue;
      for (const agent of group) {
        const rules = groups.get(agent) ?? { allow: [], disallow: [] };
        rules[key].push(value);
        groups.set(agent, rules);
      }
    }
  }
  const star = groups.get('*') ?? { allow: [], disallow: [] };
  const aiBotBlocked = AI_BOT_AGENTS.filter((agent) => !isPathAllowed('/', groups.get(agent) ?? star));
  return { ...star, sitemapUrls: [...sitemaps], found: true, aiBotBlocked };
}

// ─── Network ─────────────────────────────────────────────────────────────────

async function fetchText(f: typeof fetch, url: string, attempts = 2): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await f(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const text = await res.text();
      return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
    } catch (err) {
      lastErr = err;
      if (err instanceof EgressError) break; // proxy config error: retry cannot help
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr ?? new Error('request failed');
}

// Child sitemaps are interleaved so a small crawl samples every page type:
// Shoper's index lists products first, which would otherwise fill the crawl.
async function fetchSitemapUrls(f: typeof fetch, start: URL, policy: RobotsPolicy, limit: number): Promise<string[]> {
  const queue = policy.sitemapUrls.length ? [...policy.sitemapUrls] : [`${start.origin}/sitemap.xml`, `${start.origin}/sitemap_index.xml`];
  const seen = new Set<string>();
  const lists: string[][] = [];
  while (queue.length > 0 && seen.size < MAX_SITEMAPS) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    let xml: string;
    try { xml = await fetchText(f, sitemapUrl); } catch { continue; }
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const list: string[] = [];
    for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
      try {
        const u = new URL(decodeEntities(m[1].trim()), sitemapUrl);
        if (siteHost(u.host) !== siteHost(start.host)) continue;
        // Sitemap index children keep their query string; page URLs drop it.
        if (isIndex) { queue.push(u.toString()); continue; }
        if (shouldSkipPath(u.pathname) || !isPathAllowed(u.pathname || '/', policy)) continue;
        list.push(cleanUrl(u));
        if (list.length >= limit) break;
      } catch { /* malformed */ }
    }
    if (list.length) lists.push(list);
  }
  const out = new Set<string>();
  for (let i = 0; out.size < limit && lists.some((l) => i < l.length); i += 1) {
    for (const l of lists) if (i < l.length && out.size < limit) out.add(l[i]);
  }
  return [...out];
}

async function detectRssFeed(f: typeof fetch, startPageHtml: string, start: URL): Promise<boolean> {
  for (const link of findOpenTags(startPageHtml, 'link')) {
    if ((link.rel || '').toLowerCase().includes('alternate') && /(rss|atom)\+xml/.test((link.type || '').toLowerCase())) return true;
  }
  for (const path of ['/feed', '/rss.xml', '/atom.xml', '/feed.xml']) {
    try {
      if (/<rss[\s>]|<feed[\s>]|<channel[\s>]/i.test(await fetchText(f, `${start.origin}${path}`, 1))) return true;
    } catch { /* try next */ }
  }
  return false;
}

type LlmsTxt = { found: boolean; hasH1: boolean; hasLink: boolean; contentLength: number };
async function checkLlmsTxt(f: typeof fetch, start: URL): Promise<LlmsTxt> {
  try {
    const content = await fetchText(f, `${start.origin}/llms.txt`, 1);
    return { found: true, contentLength: content.trim().length, hasH1: /^#\s+.+/m.test(content), hasLink: /\[.+?\]\(.+?\)/.test(content) };
  } catch {
    return { found: false, hasH1: false, hasLink: false, contentLength: 0 };
  }
}

// ─── Page extraction and checks ──────────────────────────────────────────────

const isNavigable = (href: string) => !!href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:');

function extractInternalLinks(html: string, pageUrl: URL, startHost: string, policy: RobotsPolicy): string[] {
  const out = new Set<string>();
  for (const a of findOpenTags(html, 'a')) {
    if (!isNavigable(a.href || '')) continue;
    try {
      const u = new URL(a.href, pageUrl);
      if (!['http:', 'https:'].includes(u.protocol) || siteHost(u.host) !== siteHost(startHost)) continue;
      if (shouldSkipPath(u.pathname) || !isPathAllowed(u.pathname || '/', policy)) continue;
      out.add(cleanUrl(u));
    } catch { /* malformed */ }
  }
  return [...out].slice(0, 40);
}

export type AiView = ReturnType<typeof extractAiView>;

export function extractAiView(html: string, pageUrl: URL) {
  const title = collapse(decodeEntities(stripTags(firstInner(html, 'title'))));
  const metaTags = findOpenTags(html, 'meta');
  const metaByName: Record<string, string> = {};
  const metaByProp: Record<string, string> = {};
  for (const m of metaTags) {
    if (m.name) metaByName[m.name.toLowerCase()] = m.content || '';
    if (m.property) metaByProp[m.property.toLowerCase()] = m.content || '';
  }
  const h1 = allInner(html, 'h1').map((t) => collapse(stripTags(t))).filter(Boolean).slice(0, 8);
  const headings = [...html.matchAll(/<(h[23])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => collapse(stripTags(m[2]))).filter(Boolean);

  const jsonLdBlocks = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const schemaTypes: string[] = [];
  const jsonLdParts: string[] = [];
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block.trim());
      const items = Array.isArray(data) ? data : Array.isArray(data['@graph']) ? data['@graph'] : [data];
      for (const item of items) {
        if (!item?.['@type']) continue;
        const types: string[] = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        schemaTypes.push(...types);
        const fields = [`@type=${types.join(',')}`];
        if (item.name) fields.push(`name=${String(item.name).slice(0, 80)}`);
        const author = typeof item.author === 'string' ? item.author : item.author?.name;
        if (author) fields.push(`author=${String(author).slice(0, 60)}`);
        if (item.datePublished) fields.push(`datePublished=${String(item.datePublished).slice(0, 20)}`);
        if (item.dateModified) fields.push(`dateModified=${String(item.dateModified).slice(0, 20)}`);
        if (item.publisher?.name) fields.push(`publisher=${String(item.publisher.name).slice(0, 60)}`);
        if (item.description) fields.push(`description=${String(item.description).slice(0, 100)}`);
        jsonLdParts.push(fields.join(' | '));
      }
    } catch { /* malformed JSON-LD */ }
  }

  let internalLinkCount = 0;
  for (const a of findOpenTags(html, 'a')) {
    if (!isNavigable(a.href || '')) continue;
    try { if (siteHost(new URL(a.href, pageUrl).host) === siteHost(pageUrl.host)) internalLinkCount += 1; } catch { /* malformed */ }
  }

  const bodyInner = firstInner(html, 'body') || html;
  const timeDatetime = html.match(/<time\b[^>]*\bdatetime\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
  const robotsMeta = metaTags.filter((m) => ['robots', 'googlebot'].includes((m.name || '').toLowerCase()));
  const aiMetaTags = ['nosnippet', 'noai', 'noimageai'].filter((t) =>
    // `noai` must not match inside `noimageai`.
    robotsMeta.some((m) => new RegExp(`(^|[\\s,])${t}($|[\\s,])`).test((m.content || '').toLowerCase())));
  const canonical = findOpenTags(html, 'link').find((l) => (l.rel || '').toLowerCase() === 'canonical' && l.href)?.href.trim() ?? '';
  const imgs = findOpenTags(html, 'img');

  return {
    title,
    metaDescription: (metaByName.description || '').trim(),
    h1,
    h1Count: (html.match(/<h1\b[^>]*>/gi) || []).length,
    headings: headings.slice(0, 16),
    jsonLdCount: jsonLdBlocks.length,
    schemaTypes: [...new Set(schemaTypes)],
    jsonLdSummary: jsonLdParts.slice(0, 5).join('\n'),
    internalLinkCount,
    textExcerpt: contentExcerpt(bodyInner),
    bodyWordCount: visibleText(bodyInner).split(/\s+/).filter(Boolean).length,
    publishedDate: metaByProp['article:published_time'] || metaByName.date || metaByName['dc.date'] || timeDatetime || '',
    modifiedDate: metaByProp['article:modified_time'] || metaByName['last-modified'] || '',
    author: metaByName.author || metaByProp['article:author'] || '',
    aiMetaTags,
    hasNoindex: robotsMeta.some((m) => (m.name || '').toLowerCase() === 'robots' && (m.content || '').toLowerCase().includes('noindex')),
    canonical,
    hasOg: !!metaByProp['og:title'] && !!metaByProp['og:description'],
    imgCount: imgs.length,
    imgsWithAlt: imgs.filter((i) => (i.alt || '').trim().length > 0).length,
    headingLevels: [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => Number(m[1])),
  };
}

export type Check = { id: string; label: string; passed: boolean; points: number; details: string };

export function scorePageChecks(v: AiView): { checks: Check[]; score: number; maxScore: number } {
  const foundTypes = v.schemaTypes.filter((t) => RECOGNIZED_SCHEMA_TYPES.includes(t));
  const headingSkipped = v.headingLevels.some((lvl, i) => i > 0 && lvl - v.headingLevels[i - 1] > 1);
  const uniqueLevels = new Set(v.headingLevels).size;
  const altRatio = v.imgCount === 0 ? 1 : v.imgsWithAlt / v.imgCount;
  const checks: Check[] = [
    { id: 'title', label: 'Clear page title', passed: v.title.length >= 10, points: 10,
      details: v.title ? `Found title (${v.title.length} chars).` : 'No <title> found.' },
    { id: 'meta-description', label: 'Meta description', passed: v.metaDescription.length >= 50, points: 10,
      details: v.metaDescription ? `Found description (${v.metaDescription.length} chars).` : 'No meta description found.' },
    { id: 'canonical', label: 'Canonical URL', passed: v.canonical.length > 0, points: 8,
      details: v.canonical ? `Canonical: ${v.canonical}` : 'No canonical tag found.' },
    { id: 'h1', label: 'Single H1 heading', passed: v.h1Count === 1, points: 8, details: `Found ${v.h1Count} h1 tag(s).` },
    { id: 'schema', label: 'Structured data present', passed: v.jsonLdCount > 0, points: 8,
      details: v.jsonLdCount > 0 ? `Found ${v.jsonLdCount} JSON-LD block(s).` : 'No JSON-LD structured data found.' },
    { id: 'schema-types', label: 'Schema types identified', passed: foundTypes.length > 0, points: 8,
      details: foundTypes.length > 0 ? `Types: ${foundTypes.join(', ')}` : 'No recognized @type found in JSON-LD.' },
    { id: 'og', label: 'Open Graph basics', passed: v.hasOg, points: 8,
      details: v.hasOg ? 'og:title and og:description found.' : 'Missing og:title and/or og:description.' },
    { id: 'internal-links', label: 'Internal linking', passed: v.internalLinkCount >= 5, points: 10,
      details: `Found ${v.internalLinkCount} internal links.` },
    { id: 'image-alt', label: 'Image alt coverage', passed: altRatio >= 0.8, points: 8,
      details: v.imgCount === 0 ? 'No images on page.' : `${v.imgsWithAlt}/${v.imgCount} images include alt text.` },
    { id: 'text-depth', label: 'Readable content depth', passed: v.bodyWordCount >= 250, points: 12,
      details: `Estimated ${v.bodyWordCount} words in body text.` },
    { id: 'indexability', label: 'Indexable for discovery', passed: !v.hasNoindex, points: 10,
      details: v.hasNoindex ? 'Page has noindex directive.' : 'No noindex directive found.' },
    { id: 'ai-meta-tags', label: 'AI-accessible meta tags', passed: v.aiMetaTags.length === 0, points: 6,
      details: v.aiMetaTags.length === 0 ? 'No restrictive AI meta tags.' : `Restrictive tags: ${v.aiMetaTags.join(', ')}` },
    { id: 'heading-hierarchy', label: 'Content structure', passed: !headingSkipped && uniqueLevels >= 2, points: 6,
      details: v.headingLevels.length === 0 ? 'No headings found.'
        : uniqueLevels < 2 ? 'Only one heading level used.'
        : headingSkipped ? 'Heading levels skipped.'
        : `Clean heading structure (${uniqueLevels} levels).` },
  ];
  const score = checks.reduce((s, c) => s + (c.passed ? c.points : 0), 0);
  return { checks, score, maxScore: checks.reduce((s, c) => s + c.points, 0) };
}

type PageAudit = { url: string; score: number; maxScore: number; checks: Check[]; aiView: AiView; pageType: string };

// JSON-LD first (Shoper product URLs are bare slugs like /Niezly-Bigos), then
// Shoper URL shapes (/pl/p/, /pl/c/, /pl/i/), then the reference's generic ones.
function classifyPageType(url: string, v: AiView): string {
  const path = new URL(url).pathname.toLowerCase();
  if (path === '/' || path === '' || /^\/[a-z]{2}$/.test(path)) return 'home';
  if (v.schemaTypes.includes('Product')) return 'product';
  if (/\/p\/[^/]+\/\d+$/.test(path) || /(^|\/)(product|products)(\/|$)/.test(path)) return 'product';
  if (/\/c\/[^/]+\/\d+$/.test(path) || /(^|\/)(category|categories)(\/|$)/.test(path)) return 'category';
  if (/\/i\/[^/]+\/\d+$/.test(path) || /(^|\/)(about|company|contact|info)(\/|$)/.test(path)) return 'info';
  if (/\/producer\/[^/]+\/\d+$/.test(path)) return 'producer';
  if (/\/n\/[^/]+\/\d+$/.test(path) || /(^|\/)(blog|news|article|articles)(\/|$)/.test(path)) return 'blog';
  return 'other';
}

/** Site-wide: a check passes when 80%+ of crawled pages pass it. */
export function aggregateChecks(pages: PageAudit[]): Check[] {
  const byId = new Map<string, { label: string; points: number; pass: number; total: number }>();
  for (const page of pages) {
    for (const c of page.checks) {
      const row = byId.get(c.id) ?? { label: c.label, points: c.points, pass: 0, total: 0 };
      row.total += 1;
      if (c.passed) row.pass += 1;
      byId.set(c.id, row);
    }
  }
  return [...byId].map(([id, r]) => ({
    id, label: r.label, points: r.points,
    passed: r.total > 0 && r.pass / r.total >= 0.8,
    details: `${r.pass}/${r.total} pages passed this check.`,
  }));
}

function pageRichness(p: PageAudit): number {
  const v = p.aiView;
  return v.textExcerpt.length / 200 + (v.schemaTypes.length ? 3 : 0) + (v.jsonLdSummary ? 2 : 0) + (v.author ? 2 : 0)
    + (v.publishedDate || v.modifiedDate ? 2 : 0) + Math.min(v.headings.length, 6)
    + (['blog', 'product', 'category'].includes(p.pageType) ? 4 : p.pageType === 'other' ? 2 : 0);
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export async function auditSite(f: typeof fetch, domain: string, maxPages = 10) {
  const startedAt = Date.now();
  maxPages = Math.max(1, Math.min(MAX_CRAWL_LIMIT, Math.floor(maxPages)));
  const startUrl = cleanUrl(new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`));
  const start = new URL(startUrl);
  const robotsUrl = `${start.origin}/robots.txt`;

  const [robots, llmsTxt] = await Promise.all([
    fetchText(f, robotsUrl).then((t) => parseRobots(t, robotsUrl), (): RobotsPolicy =>
      ({ allow: [], disallow: [], sitemapUrls: [], found: false, aiBotBlocked: [] })),
    checkLlmsTxt(f, start),
  ]);
  const sitemapUrls = await fetchSitemapUrls(f, start, robots, Math.min(maxPages * 8, 400));

  const queue = [startUrl, ...sitemapUrls.filter((u) => u !== startUrl)];
  const seen = new Set(queue);
  const pages: PageAudit[] = [];
  let robotsBlocked = 0;
  let failedPages = 0;
  let firstError = '';
  let startPageHtml = '';

  async function processUrl(current: string, isFirst: boolean) {
    const url = new URL(current);
    if (!isPathAllowed(url.pathname || '/', robots)) { robotsBlocked += 1; return; }
    try {
      const html = await fetchText(f, current);
      if (isFirst) startPageHtml = html;
      const aiView = extractAiView(html, url);
      const { checks, score, maxScore } = scorePageChecks(aiView);
      pages.push({ url: current, score, maxScore, checks, aiView, pageType: classifyPageType(current, aiView) });
      for (const link of extractInternalLinks(html, url, start.host, robots)) {
        if (pages.length + queue.length >= maxPages * 4) break;
        if (!seen.has(link)) { seen.add(link); queue.push(link); }
      }
    } catch (err) {
      failedPages += 1;
      firstError ||= err instanceof Error ? err.message : String(err);
    }
  }

  await processUrl(queue.shift()!, true);
  while (queue.length > 0 && pages.length < maxPages) {
    const batch = queue.splice(0, Math.min(CRAWL_CONCURRENCY, maxPages - pages.length));
    await Promise.all(batch.map((u) => processUrl(u, false)));
  }
  if (pages.length === 0) {
    throw new Error(`Could not crawl any page from ${startUrl}: ${firstError || 'every URL was blocked by robots.txt'}. Check the brand domain and that its host is in the egress proxy ALLOWED_HOSTS.`);
  }

  const rssFeed = await detectRssFeed(f, startPageHtml, start);
  const llmsValid = llmsTxt.found && llmsTxt.hasH1 && llmsTxt.hasLink && llmsTxt.contentLength > 100;
  const checks = aggregateChecks(pages);
  checks.push(
    { id: 'llms-txt', label: 'llms.txt valid (informational, 0 pts)', passed: llmsValid, points: 0,
      details: !llmsTxt.found ? 'No llms.txt found.' : llmsValid ? `Valid llms.txt (${llmsTxt.contentLength} chars).`
        : `Found llms.txt but ${!llmsTxt.hasH1 ? 'missing # heading' : !llmsTxt.hasLink ? 'missing links' : 'too short'}.` },
    { id: 'ai-bot-access', label: 'AI bot access', passed: robots.aiBotBlocked.length === 0, points: 12,
      details: !robots.found ? 'No robots.txt found (nothing blocked).'
        : robots.aiBotBlocked.length === 0 ? 'No AI bots blocked in robots.txt.' : `Blocked: ${robots.aiBotBlocked.join(', ')}` },
    { id: 'rss-feed', label: 'RSS/Atom feed', passed: rssFeed, points: 8,
      details: rssFeed ? 'RSS or Atom feed detected.' : 'No RSS/Atom feed found.' },
  );
  const earned = checks.reduce((s, c) => s + (c.passed ? c.points : 0), 0);
  const max = checks.reduce((s, c) => s + c.points, 0);

  const home = pages.find((p) => p.pageType === 'home');
  const pagesForReview = [...(home ? [home] : []), ...pages.filter((p) => p !== home).sort((a, b) => pageRichness(b) - pageRichness(a))]
    .slice(0, 5)
    .map(({ url, pageType, score, maxScore, aiView }) => ({ url, pageType, score, maxScore, aiView }));

  return {
    url: startUrl,
    generatedAt: new Date().toISOString(),
    crawledPages: pages.length,
    maxPages,
    foundationalScore: scoreToInt((earned / Math.max(1, max)) * 100),
    scoring: `16 deterministic checks, ${max} points (llms.txt weighs 0). A site-wide check passes when 80%+ of crawled pages pass it. Not a traffic prediction. Score the 6 content dimensions (answer readiness, quotability, evidence density, content depth, freshness, structural clarity) from pagesForReview yourself.`,
    checks,
    robots: { found: robots.found, aiBotBlocked: robots.aiBotBlocked, sitemaps: robots.sitemapUrls },
    llmsTxt,
    rssFeed,
    pageTypes: Object.fromEntries([...new Set(pages.map((p) => p.pageType))].map((t) => [t, pages.filter((p) => p.pageType === t).length])),
    worstPages: [...pages].sort((a, b) => a.score / a.maxScore - b.score / b.maxScore).slice(0, 5).map((p) => ({
      url: p.url, pageType: p.pageType, score: p.score, maxScore: p.maxScore, failed: p.checks.filter((c) => !c.passed).map((c) => c.id),
    })),
    pagesForReview,
    diagnostics: { crawlMs: Date.now() - startedAt, discoveredFromSitemap: sitemapUrls.length, robotsBlocked, failedPages, firstError: firstError || undefined },
  };
}

export function registerSiteAuditTool(server: McpServer, db: Db, f: typeof fetch): void {
  server.registerTool(
    'site.audit',
    {
      title: 'AEO site audit',
      description:
        "Crawl a tracked brand's own site like an AI agent (robots.txt, sitemap, links) and run 16 deterministic AEO checks: AI bot access, indexability, title/meta, canonical, H1 and heading outline, JSON-LD, Open Graph, alt text, text depth, RSS. Returns a foundational score, failed checks, weakest pages and 5 pages for your content review. Example: brand_id='studiokoloru'.",
      inputSchema: {
        brand_id: z.string().describe('Tracked brand ID; its domain is crawled.'),
        max_pages: z.number().int().min(1).max(MAX_CRAWL_LIMIT).optional().describe('Pages to crawl, default 10, max 30.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ brand_id, max_pages }) => {
      const brand = await db.getBrand(brand_id);
      if (!brand) throw new Error(`Unknown brand_id '${brand_id}'. Call list_brands for tracked IDs.`);
      const payload = { brand_id, ...(await auditSite(f, brand.domain, max_pages ?? 10)) };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );
}
