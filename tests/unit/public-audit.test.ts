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
  assert.doesNotMatch(body, /guaranteed (?:rank|traffic|citation)/i);
  assert.doesNotMatch(body, /GitHub Sponsors is active/i);
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
