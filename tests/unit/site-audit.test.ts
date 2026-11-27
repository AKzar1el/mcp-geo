import assert from 'node:assert/strict';
import test from 'node:test';
import { EgressError, egressFetch, signature } from '../../src/core/egress.ts';
import { auditSite, extractAiView, isPathAllowed, parseRobots, scorePageChecks } from '../../src/core/site-audit.ts';

test('egress signature matches shoper-growth-mcp proxy/sign.mjs byte for byte', async () => {
  // Vector computed with proxy/sign.mjs on 27 Nov 2026.
  assert.equal(
    await signature('k', { ts: '1700000000', nonce: '0'.repeat(32), method: 'GET', host: 'studiokoloru.eu', path: '/robots.txt' }),
    '0dda0ea54392a28379e1de217938fc4278d92d8df9c086cb46343276c121f9cb',
  );
});

test('egressFetch signs the target into headers, follows redirects, surfaces proxy refusals', async () => {
  const seen: string[] = [];
  const proxy = (async (_url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    seen.push(`${h.get('x-egress-host')}${h.get('x-egress-path')}`);
    if (h.get('x-egress-host') === 'www.shop.pl') return new Response(null, { status: 301, headers: { location: 'https://shop.pl/a?b=1' } });
    if (h.get('x-egress-host') === 'evil.pl') return new Response('{"error":"host not allowed: evil.pl"}', { status: 403, headers: { 'x-egress-error': '1' } });
    return new Response('ok');
  }) as typeof fetch;
  const f = egressFetch('https://proxy.test', 'key', proxy);
  assert.equal(await (await f('https://www.shop.pl/')).text(), 'ok');
  assert.deepEqual(seen, ['www.shop.pl/', 'shop.pl/a?b=1']);
  await assert.rejects(f('https://evil.pl/'), EgressError);
  await assert.rejects(egressFetch('https://proxy.test', '', proxy)('https://shop.pl/'), /SHOPER_PROXY_KEY is missing/);
});

test('robots.txt: shared User-agent groups, wildcards, AI bots inherit *', () => {
  // Shape of studiokoloru.eu/robots.txt: one group naming many agents.
  const shoper = parseRobots(
    'User-agent: *\nCrawl-delay: 1\n\nUser-agent: *\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /*/basket\nDisallow: /application\n\nSitemap: https://shop.pl/sitemap',
    'https://shop.pl/robots.txt',
  );
  assert.deepEqual(shoper.aiBotBlocked, []);
  assert.deepEqual(shoper.sitemapUrls, ['https://shop.pl/sitemap']);
  assert.equal(isPathAllowed('/pl/basket', shoper), false);
  assert.equal(isPathAllowed('/pl/p/book/1', shoper), true);

  const blockAll = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n', 'https://shop.pl/robots.txt');
  assert.ok(!blockAll.aiBotBlocked.includes('gptbot'));
  assert.ok(blockAll.aiBotBlocked.includes('claudebot'));
});

test('page checks: full page passes all 13, noimageai is not noai', () => {
  const words = Array.from({ length: 300 }, (_, i) => `słowo${i}`).join(' ');
  const html = `<html><head><title>Książki dla dzieci</title>
    <meta name="description" content="Kolorowe książki dla dzieci od polskiego wydawnictwa, ręcznie ilustrowane.">
    <meta name="robots" content="index, follow, noimageai">
    <link rel="canonical" href="https://shop.pl/"><meta property="og:title" content="x"><meta property="og:description" content="y">
    <script type="application/ld+json">[{"@type":"Organization","name":"Shop"}]</script></head>
    <body><h1>Książki</h1><h2>Nowości</h2>${'<a href="/pl/c/x/1">x</a>'.repeat(5)}<img src="a.jpg" alt="okładka"><p>${words}</p></body></html>`;
  const view = extractAiView(html, new URL('https://shop.pl/'));
  assert.deepEqual(view.schemaTypes, ['Organization']);
  assert.deepEqual(view.aiMetaTags, ['noimageai']);
  const { checks } = scorePageChecks(view);
  assert.deepEqual(checks.filter((c) => !c.passed).map((c) => c.id), ['ai-meta-tags']);
});

test('auditSite crawls robots + sitemap index + pages, llms.txt weighs 0', async () => {
  const page = (title: string) =>
    `<html><head><title>${title}</title></head><body><h1>${title}</h1><a href="/pl/basket">koszyk</a></body></html>`;
  const site: Record<string, string> = {
    'https://shop.pl/robots.txt': 'User-agent: *\nDisallow: /*/basket\nSitemap: https://shop.pl/sm',
    'https://shop.pl/sm': '<sitemapindex><sitemap><loc>https://shop.pl/sm/products</loc></sitemap></sitemapindex>',
    'https://shop.pl/sm/products': '<urlset><url><loc>https://shop.pl/pl/p/ksiazka/1</loc></url><url><loc>https://www.shop.pl/pl/p/inna/2</loc></url><url><loc>https://shop.pl/Niezly-Bigos</loc></url></urlset>',
    'https://shop.pl/': page('Strona główna sklepu'),
    'https://shop.pl/pl/p/ksiazka/1': page('Książka pierwsza'),
    'https://shop.pl/Niezly-Bigos': page('Bigos').replace('</head>', '<script type="application/ld+json">{"@type":"Product"}</script></head>'),
    'https://www.shop.pl/pl/p/inna/2': page('Książka druga'),
  };
  const fetched: string[] = [];
  const f = (async (input: string) => {
    fetched.push(input);
    return site[input] ? new Response(site[input]) : new Response('nope', { status: 404 });
  }) as typeof fetch;

  const r = await auditSite(f, 'shop.pl', 10);
  assert.equal(r.crawledPages, 4);
  assert.deepEqual(r.pageTypes, { home: 1, product: 3 });
  assert.ok(!fetched.includes('https://shop.pl/pl/basket'), 'robots Disallow respected');
  assert.equal(r.checks.length, 16);
  assert.equal(r.checks.find((c) => c.id === 'llms-txt')?.points, 0);
  assert.equal(r.checks.reduce((s, c) => s + c.points, 0), 132);
  assert.equal(r.checks.find((c) => c.id === 'ai-bot-access')?.passed, true);
  assert.equal(r.pagesForReview[0].pageType, 'home');

  await assert.rejects(auditSite((async () => new Response('', { status: 421 })) as typeof fetch, 'shop.pl'), /HTTP 421/);
});

test('auditSite interleaves child sitemaps so a small crawl samples every page type', async () => {
  const page = '<html><head><title>t</title></head><body></body></html>';
  const site: Record<string, string> = {
    'https://shop.pl/robots.txt': 'Sitemap: https://shop.pl/sm',
    'https://shop.pl/sm': '<sitemapindex><sitemap><loc>https://shop.pl/sm/p</loc></sitemap><sitemap><loc>https://shop.pl/sm/c</loc></sitemap></sitemapindex>',
    'https://shop.pl/sm/p': '<urlset><url><loc>https://shop.pl/pl/p/a/1</loc></url><url><loc>https://shop.pl/pl/p/b/2</loc></url></urlset>',
    'https://shop.pl/sm/c': '<urlset><url><loc>https://shop.pl/pl/c/kat/3</loc></url></urlset>',
  };
  const f = (async (input: string) => new Response(site[input] ?? page)) as typeof fetch;
  const r = await auditSite(f, 'shop.pl', 3);
  assert.deepEqual(r.pageTypes, { home: 1, product: 1, category: 1 });
});
