import assert from 'node:assert/strict';
import test from 'node:test';

async function loadAuditModule() {
  try {
    return await import('../../src/public-audit');
  } catch (error) {
    assert.fail(`public audit module is not implemented: ${String(error)}`);
  }
}

test('GET /audit serves the frozen EUR 99 audit offer', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/audit'),
  );

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const body = await response.text();
  assert.match(body, /EUR 99/);
  assert.match(body, /one-time AI Visibility Audit/i);
  assert.match(body, /up to three competitors/i);
  assert.match(body, /20 buyer-intent prompts/i);
  assert.match(body, /up to five/i);
  assert.match(body, /info@tomiseregi\.si/);
  assert.match(body, /open-source/i);
  assert.match(body, /See a sample report/i);
  assert.match(body, /docs\/demo-report-full\.png/);
  assert.doesNotMatch(body, /guaranteed (?:rank|traffic|citation)/i);
  assert.doesNotMatch(body, /GitHub Sponsors is active/i);
});

test('GET /audit exposes canonical, social, and structured discovery metadata', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/audit'),
  );

  assert.ok(response);
  const body = await response.text();
  assert.match(
    body,
    /<link rel="canonical" href="https:\/\/geo-mcp\.digestseo\.com\/audit">/,
  );
  assert.match(
    body,
    /<meta property="og:url" content="https:\/\/geo-mcp\.digestseo\.com\/audit">/,
  );
  assert.match(body, /<meta property="og:type" content="website">/);
  assert.match(body, /<meta name="twitter:card" content="summary">/);

  const structuredData = body.match(
    /<script type="application\/ld\+json">([^<]+)<\/script>/,
  )?.[1];
  assert.ok(structuredData);
  const schema = JSON.parse(structuredData) as {
    '@type'?: string;
    url?: string;
    offers?: { price?: string; priceCurrency?: string };
  };
  assert.equal(schema['@type'], 'Service');
  assert.equal(schema.url, 'https://geo-mcp.digestseo.com/audit');
  assert.deepEqual(schema.offers, { price: '99', priceCurrency: 'EUR' });
});

test('GET /robots.txt and /sitemap.xml expose the audit discovery URL', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const robots = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/robots.txt'),
  );
  const sitemap = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/sitemap.xml'),
  );

  assert.ok(robots);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type') ?? '', /text\/plain/);
  const robotsBody = await robots.text();
  assert.match(robotsBody, /User-agent: \*/);
  assert.match(robotsBody, /Allow: \/audit/);
  assert.match(
    robotsBody,
    /Sitemap: https:\/\/geo-mcp\.digestseo\.com\/sitemap\.xml/,
  );

  assert.ok(sitemap);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type') ?? '', /application\/xml/);
  const sitemapBody = await sitemap.text();
  assert.match(
    sitemapBody,
    /<loc>https:\/\/geo-mcp\.digestseo\.com\/audit<\/loc>/,
  );
});

test('audit CTA opens a prefilled attributable request email', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/audit'),
  );

  assert.ok(response);
  const body = await response.text();
  const href = body.match(/<a class=\"cta\" href=\"([^\"]+)\"/)?.[1];
  assert.ok(href);

  const mailto = new URL(href);
  assert.equal(mailto.protocol, 'mailto:');
  assert.equal(mailto.pathname, 'info@tomiseregi.si');
  assert.equal(
    mailto.searchParams.get('subject'),
    'mcp-geo AI Visibility Audit - EUR 99',
  );
  assert.match(mailto.searchParams.get('body') ?? '', /Brand\/domain:/);
  assert.match(mailto.searchParams.get('body') ?? '', /Competitors \(up to 3\):/);
  assert.match(mailto.searchParams.get('body') ?? '', /Source: mcp-geo audit page/);
});

test('audit request flow provides form, clipboard, direct-email, and no-JS fallbacks', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/audit'),
  );

  assert.ok(response);
  const body = await response.text();
  assert.match(body, /<form id="audit-request-form"/);
  assert.match(body, /name="brand"[^>]*required/);
  assert.match(body, /name="competitors"/);
  assert.match(body, /name="context"/);
  assert.match(body, /type="submit"[^>]*>Request the EUR 99 audit</);
  assert.match(body, /id="copy-request"[^>]*>Copy request details</);
  assert.match(body, /navigator\.clipboard\.writeText/);
  assert.match(body, /document\.execCommand\('copy'\)/);
  assert.match(body, /aria-live="polite"/);
  assert.match(body, /Email <a href="mailto:info@tomiseregi\.si"/);
  assert.match(body, /<noscript>[\s\S]*mailto:info@tomiseregi\.si/);
});

test('non-GET /audit requests are rejected without entering MCP or admin flows', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/audit', { method: 'POST' }),
  );

  assert.ok(response);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});

test('non-audit paths are ignored by the public audit router', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/healthz'),
  );

  assert.equal(response, null);
});
