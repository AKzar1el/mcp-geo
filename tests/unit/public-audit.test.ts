import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

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
  assert.match(body, /self-hosting instructions/i);
  assert.doesNotMatch(body, /connect to the MCP endpoint/i);
  assert.doesNotMatch(body, /https:\/\/geo-mcp\.digestseo\.com\/mcp/);
  assert.match(body, /See a sample report/i);
  assert.match(body, /docs\/demo-report-full\.png/);
  assert.match(body, /point-in-time diagnostic/i);
  assert.match(body, /reported per engine/i);
  assert.match(body, /same 20 buyer-intent prompts/i);
  assert.match(body, /See the exact score calculation and interpretation limits/i);
  assert.match(
    body,
    /https:\/\/github\.com\/AKzar1el\/mcp-geo\/blob\/main\/docs\/ai-visibility-audit-methodology\.md/,
  );
  assert.match(body, /concise, plain-English prioritized content-gap and action memo/i);
  assert.match(body, /implementation is not included/i);
  assert.match(body, /confirm fit and scope by email/i);
  assert.match(body, /existing invoice and payment process/i);
  assert.match(body, /does not collect payment details/i);
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

test('GET /privacy serves the owned local-connector privacy policy', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/privacy'),
  );

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
  const body = await response.text();
  assert.match(body, /local mcp-geo package and Claude Desktop extension/i);
  assert.match(body, /Data use and storage/);
  assert.match(body, /Third-party processing/);
  assert.match(body, /Retention and deletion/);
  assert.match(body, /info@tomiseregi\.si/);
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

test('GET / routes users to supported local or self-hosted setup, not the unconfigured public MCP endpoint', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/'),
  );

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/plain/);

  const body = await response.text();
  assert.match(body, /DigestSEO AI Visibility MCP server/);
  assert.match(body, /npx -y @digestseo\/mcp-geo/);
  assert.match(body, /github\.com\/AKzar1el\/mcp-geo\/blob\/main\/SETUP\.md/);
  assert.match(body, /not a turnkey fresh-scan service/i);
  assert.doesNotMatch(body, /https:\/\/geo-mcp\.digestseo\.com\/mcp/);
  assert.doesNotMatch(body, /Connect this URL as a custom MCP connector/i);
  assert.match(body, /EUR 99 AI Visibility Audit/);
  assert.match(body, /https:\/\/geo-mcp\.digestseo\.com\/audit/);
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
  assert.match(mailto.searchParams.get('body') ?? '', /Category \/ product type:/);
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
  assert.match(body, /name="category"[^>]*required/);
  assert.match(body, /Category \/ product type/);
  assert.match(body, /name="competitors"/);
  assert.match(body, /name="context"/);
  assert.match(body, /type="submit"[^>]*>Request the EUR 99 audit</);
  assert.match(body, /id="copy-request"[^>]*>Copy request details</);
  assert.match(body, /id="download-request"[^>]*>Download request details</);
  assert.match(body, /navigator\.clipboard\.writeText/);
  assert.match(body, /document\.execCommand\('copy'\)/);
  assert.match(body, /aria-live="polite"/);
  assert.match(body, /Email <a href="mailto:info@tomiseregi\.si"/);
  assert.match(body, /<noscript>[\s\S]*mailto:info@tomiseregi\.si/);
});

test('audit form validates scope and preserves oversized email requests with the copy fallback', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(new Request('https://geo-mcp.digestseo.com/audit'));
  assert.ok(response);
  const html = await response.text();
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  assert.ok(script);

  type Handler = (event: { preventDefault(): void }) => void | Promise<void>;
  class FakeForm {
    values: Record<string, string> = {
      brand: 'example.com',
      category: 'Project management',
      competitors: '',
      context: '',
    };
    handlers = new Map<string, Handler>();
    addEventListener(name: string, callback: Handler) { this.handlers.set(name, callback); }
    reportValidity() { return true; }
  }
  class FakeButton {
    handlers = new Map<string, Handler>();
    addEventListener(name: string, callback: Handler) { this.handlers.set(name, callback); }
  }
  class FakeFormData {
    constructor(private readonly form: FakeForm) {}
    get(name: string) { return this.form.values[name] ?? null; }
  }
  const form = new FakeForm();
  const button = new FakeButton();
  const downloadButton = new FakeButton();
  const status = { textContent: '' };
  const location = { href: '' };
  const copied: string[] = [];
  const downloads: Array<{ filename: string; href: string }> = [];
  const blobs: Array<{ parts: string[]; options: { type: string } }> = [];
  const revoked: string[] = [];
  let clipboardAllowed = true;
  let downloadAvailable = true;
  let legacyCopyThrows = false;
  let appendedLegacyTextareas = 0;
  let removedLegacyTextareas = 0;
  runInNewContext(script, {
    document: {
      getElementById(id: string) {
        return id === 'audit-request-form' ? form
          : id === 'copy-request' ? button
          : id === 'download-request' ? downloadButton
          : status;
      },
      body: { appendChild(node: { select?: () => void }) {
        if (node.select) appendedLegacyTextareas++;
      } },
      createElement(tag: string) {
        if (tag === 'a') {
          return {
            href: '', download: '',
            click() { downloads.push({ filename: this.download, href: this.href }); },
            remove() {},
          };
        }
        return {
          value: '', style: {}, setAttribute() {}, select() {},
          remove() { removedLegacyTextareas++; },
        };
      },
      execCommand() {
        if (legacyCopyThrows) throw new Error('synthetic legacy clipboard denial');
        return false;
      },
    },
    HTMLFormElement: FakeForm,
    HTMLButtonElement: FakeButton,
    FormData: FakeFormData,
    navigator: { clipboard: { writeText: async (value: string) => {
      if (!clipboardAllowed) throw new Error('clipboard denied');
      copied.push(value);
    } } },
    Blob: class {
      constructor(parts: string[], options: { type: string }) {
        blobs.push({ parts, options });
      }
    },
    URL: {
      createObjectURL() {
        if (!downloadAvailable) throw new Error('blob URLs blocked');
        return 'blob:audit-request';
      },
      revokeObjectURL(value: string) { revoked.push(value); },
    },
    window: { location },
    encodeURIComponent,
  });

  const submit = () => form.handlers.get('submit')?.({ preventDefault() {} });
  const copy = () => button.handlers.get('click')?.({ preventDefault() {} });
  const download = () => downloadButton.handlers.get('click')?.({ preventDefault() {} });

  form.values.brand = '   ';
  submit();
  assert.equal(location.href, '', 'whitespace-only brand must not open an email');
  assert.match(status.textContent, /brand\/domain and category/i);

  form.values.brand = 'example.com';
  form.values.category = '  ';
  submit();
  assert.equal(location.href, '', 'whitespace-only category must not open an email');
  form.values.category = 'Project management';
  form.values.competitors = 'one.com, two.com, three.com, four.com';
  submit();
  assert.equal(location.href, '', 'more than three competitors must not open an email');
  assert.match(status.textContent, /up to 3 competitors/i);
  await copy();
  assert.equal(copied.length, 0, 'copy must apply the same scope validation');

  form.values.competitors = 'one.com; two.com; three.com; four.com';
  submit();
  assert.equal(location.href, '', 'semicolon-separated extras must be rejected too');

  form.values.competitors = 'one.com, two.com, three.com';
  submit();
  assert.match(location.href, /^mailto:info@tomiseregi\.si\?/);
  await copy();
  assert.equal(copied.length, 1, 'a request with three competitors remains copyable');

  location.href = '';
  form.values.context = 'Detailed goals: ' + 'long buyer-intent context '.repeat(180);
  await submit();
  assert.equal(location.href, '', 'an oversized mailto URL should not be opened silently');
  assert.equal(copied.length, 2, 'the complete oversized request should be copied instead');
  assert.match(copied[1], /long buyer-intent context/);
  assert.match(copied[1], /one.com, two.com, three.com/);
  assert.match(status.textContent, /too long|email link length/i);
  assert.match(status.textContent, /copied/i);

  clipboardAllowed = false;
  await copy();
  assert.match(status.textContent, /copy failed/i);
  legacyCopyThrows = true;
  await copy();
  assert.equal(
    removedLegacyTextareas,
    appendedLegacyTextareas,
    'a throwing legacy clipboard API must not leave buyer request text in the DOM',
  );
  await download();
  assert.equal(downloads.length, 1, 'download should work without clipboard permission');
  assert.equal(downloads[0]?.filename, 'mcp-geo-audit-request.txt');
  assert.equal(downloads[0]?.href, 'blob:audit-request');
  assert.equal(blobs[0]?.options.type, 'text/plain;charset=utf-8');
  assert.match(blobs[0]?.parts.join(''), /To: info@tomiseregi\.si/);
  assert.match(blobs[0]?.parts.join(''), /Subject: mcp-geo AI Visibility Audit - EUR 99/);
  assert.match(blobs[0]?.parts.join(''), /long buyer-intent context/);
  assert.deepEqual(revoked, ['blob:audit-request'], 'download object URL must be released');
  assert.equal(location.href, '', 'download must not submit or navigate');

  downloadAvailable = false;
  await download();
  assert.match(status.textContent, /download failed/i);
  assert.equal(downloads.length, 1, 'blocked downloads must not produce a false success');
});

test('HEAD public resource requests match GET metadata without sending response bodies', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  for (const path of ['/', '/audit', '/privacy', '/robots.txt', '/sitemap.xml']) {
    const url = `https://geo-mcp.digestseo.com${path}`;
    const get = handlePublicAudit(new Request(url));
    const head = handlePublicAudit(new Request(url, { method: 'HEAD' }));
    assert.ok(get);
    assert.ok(head);
    assert.equal(head.status, get.status, `${path} HEAD must be successful`);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
    assert.equal(head.headers.get('cache-control'), get.headers.get('cache-control'));
    assert.equal(await head.text(), '', `${path} HEAD must not return a body`);
  }
});

test('public audit page aliases redirect to canonical paths without entering MCP routes', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  for (const path of ['/audit/', '/privacy/']) {
    for (const method of ['GET', 'HEAD']) {
      const response = handlePublicAudit(
        new Request(`https://geo-mcp.digestseo.com${path}?ref=guide`, { method }),
      );
      assert.ok(response, `${method} ${path} must be handled`);
      assert.equal(response.status, 308);
      assert.equal(
        response.headers.get('location'),
        `https://geo-mcp.digestseo.com${path.slice(0, -1)}?ref=guide`,
      );
      assert.equal(await response.text(), '');
    }
  }

  const post = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/audit/', { method: 'POST' }),
  );
  assert.ok(post);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.equal(handlePublicAudit(new Request('https://geo-mcp.digestseo.com/audit//')), null);
});

test('unsupported /audit methods are rejected without entering MCP or admin flows', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/audit', { method: 'POST' }),
  );

  assert.ok(response);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('non-public paths are ignored by the public audit router', async () => {
  const { handlePublicAudit } = await loadAuditModule();
  const response = handlePublicAudit(
    new Request('https://geo-mcp.digestseo.com/healthz'),
  );

  assert.equal(response, null);
});
