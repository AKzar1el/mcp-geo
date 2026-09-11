const AUDIT_EMAIL = 'info@tomiseregi.si';
const AUDIT_SUBJECT = 'mcp-geo AI Visibility Audit - EUR 99';
const PUBLIC_ORIGIN = 'https://geo-mcp.digestseo.com';
const AUDIT_URL = `${PUBLIC_ORIGIN}/audit`;
const SAMPLE_REPORT_URL =
  'https://github.com/AKzar1el/mcp-geo/blob/main/docs/demo-report-full.png';
const AUDIT_DESCRIPTION =
  'A one-time AI Visibility Audit using mcp-geo: 20 buyer-intent prompts, competitor comparison, citation evidence, and prioritized next actions.';
const AUDIT_BODY = `Hi Tomi,

I'd like the EUR 99 mcp-geo AI Visibility Audit.

Brand/domain:
Competitors (up to 3):
Context or priority (optional):

Source: mcp-geo audit page`;

const ROBOTS_BODY = `User-agent: *
Allow: /audit
Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml
`;

const SITEMAP_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${AUDIT_URL}</loc></url>
</urlset>`;

function publicRootText(origin: string): string {
  return (
    'digestseo-mcp - DigestSEO AI Visibility MCP server.\n' +
    'Connect this URL as a custom MCP connector in Claude.ai:\n' +
    `${origin}/mcp\n\n` +
    'EUR 99 AI Visibility Audit:\n' +
    `${origin}/audit\n`
  );
}

function auditHtml(origin: string): string {
  const mailto = `mailto:${AUDIT_EMAIL}?subject=${encodeURIComponent(AUDIT_SUBJECT)}&body=${encodeURIComponent(AUDIT_BODY)}`;
  const mcpUrl = `${origin}/mcp`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mcp-geo AI Visibility Audit - EUR 99</title>
  <meta name="description" content="${AUDIT_DESCRIPTION}">
  <link rel="canonical" href="${AUDIT_URL}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${AUDIT_SUBJECT}">
  <meta property="og:description" content="${AUDIT_DESCRIPTION}">
  <meta property="og:url" content="${AUDIT_URL}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${AUDIT_SUBJECT}">
  <meta name="twitter:description" content="${AUDIT_DESCRIPTION}">
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: 'mcp-geo AI Visibility Audit',
    description: AUDIT_DESCRIPTION,
    url: AUDIT_URL,
    offers: { price: '99', priceCurrency: 'EUR' },
  })}</script>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b0d10; color: #f4f6f8; }
    main { width: min(760px, calc(100% - 40px)); margin: 0 auto; padding: 72px 0 88px; }
    .eyebrow { margin: 0 0 16px; color: #9ba7b4; font-size: 13px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; max-width: 700px; font-size: clamp(40px, 8vw, 72px); line-height: .98; letter-spacing: -.05em; }
    .lede { max-width: 650px; margin: 24px 0 0; color: #c4ccd4; font-size: 20px; line-height: 1.55; }
    .price { margin: 42px 0 8px; font-size: 34px; font-weight: 800; letter-spacing: -.03em; }
    .price span { color: #9ba7b4; font-size: 16px; font-weight: 500; letter-spacing: 0; }
    ul { display: grid; gap: 12px; margin: 28px 0 36px; padding: 0; list-style: none; }
    li { padding: 14px 0; border-bottom: 1px solid #252a31; color: #dce2e8; line-height: 1.45; }
    .proof { margin: -8px 0 34px; color: #c4ccd4; line-height: 1.6; }
    .proof a { font-weight: 800; }
    .request-card { display: grid; gap: 18px; margin-top: 38px; padding: 24px; border: 1px solid #252a31; border-radius: 12px; background: #11151a; }
    label { display: grid; gap: 8px; color: #dce2e8; font-size: 14px; font-weight: 700; }
    input, textarea { width: 100%; border: 1px solid #343b45; border-radius: 8px; background: #0b0d10; color: #f4f6f8; font: inherit; font-weight: 500; padding: 12px 14px; }
    textarea { min-height: 96px; resize: vertical; }
    input:focus, textarea:focus { outline: 2px solid #f4f6f8; outline-offset: 2px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .cta, .secondary { display: inline-block; border: 0; padding: 14px 20px; border-radius: 8px; font: inherit; font-weight: 800; text-decoration: none; cursor: pointer; }
    .cta { background: #f4f6f8; color: #0b0d10; }
    .secondary { border: 1px solid #343b45; background: transparent; color: #f4f6f8; }
    .status { min-height: 22px; margin: 0; color: #c4ccd4; font-size: 14px; line-height: 1.5; }
    .fine { margin-top: 18px; color: #929daa; font-size: 14px; line-height: 1.6; }
    .oss { margin-top: 56px; padding-top: 24px; border-top: 1px solid #252a31; color: #aeb8c2; line-height: 1.65; }
    a { color: inherit; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">mcp-geo / fixed-price diagnostic</p>
    <h1>One-time AI Visibility Audit</h1>
    <p class="lede">A focused baseline for founders and small marketing teams who want to see where their brand appears in AI answers, which competitors win the same buyer-intent prompts, and what to address first.</p>

    <p class="price">EUR 99 <span>/ one time</span></p>
    <ul>
      <li>One brand/domain and up to three competitors.</li>
      <li>20 buyer-intent prompts tailored to the brand and category.</li>
      <li>Checks across up to five mcp-geo-supported AI surfaces where configured providers return usable results.</li>
      <li>Visibility/share-of-voice comparison plus citation and source evidence where returned.</li>
      <li>A concise, plain-English prioritized content-gap and action memo grounded in the observed prompt results.</li>
      <li>Target delivery within two business days after usable brand and competitor input is received.</li>
    </ul>

    <p class="proof"><a href="${SAMPLE_REPORT_URL}">See a sample report</a> generated through mcp-geo before you request the audit. It shows the output style and evidence depth; your paid audit is run for your own brand, prompts, and competitors.</p>
    <p class="proof"><strong>Methodology:</strong> The same 20 buyer-intent prompts are run as a point-in-time diagnostic and reported per engine, with citation/source evidence where the provider returns it. The report is a bounded observed snapshot, not a proprietary ranking promise or guaranteed forecast.</p>

    <form id="audit-request-form" class="request-card">
      <label>
        Brand/domain
        <input name="brand" type="text" autocomplete="url" placeholder="example.com" required>
      </label>
      <label>
        Competitors (up to 3)
        <input name="competitors" type="text" placeholder="competitor-one.com, competitor-two.com">
      </label>
      <label>
        Context or priority (optional)
        <textarea name="context" placeholder="What market, product, or buyer journey matters most?"></textarea>
      </label>
      <div class="actions">
        <button class="cta" type="submit">Request the EUR 99 audit</button>
        <button class="secondary" type="button" id="copy-request">Copy request details</button>
      </div>
      <p id="request-status" class="status" role="status" aria-live="polite"></p>
    </form>

    <p class="fine">After you email the request, Tomi will confirm fit and scope by email, then use the existing invoice and payment process. This page does not collect payment details.</p>
    <p class="fine">Email <a href="mailto:${AUDIT_EMAIL}">${AUDIT_EMAIL}</a> directly if your browser does not open an email app. No subscription, no sales call required. The audit does not guarantee rankings, citations, traffic, or commercial outcomes.</p>
    <a class="cta" href="${mailto}">Email the EUR 99 audit request</a>
    <noscript><p class="fine">JavaScript is optional. You can still <a href="${mailto}">email the prefilled audit request</a> directly.</p></noscript>

    <p class="oss">Prefer to run it yourself? <strong>mcp-geo remains free and open-source under MIT.</strong> Use the local npm package or connect to the MCP endpoint at <a href="${mcpUrl}">${mcpUrl}</a>. Source and setup instructions are on <a href="https://github.com/AKzar1el/mcp-geo">GitHub</a>.</p>
  </main>
  <script>
    (() => {
      const form = document.getElementById('audit-request-form');
      const copyButton = document.getElementById('copy-request');
      const status = document.getElementById('request-status');
      if (!(form instanceof HTMLFormElement) || !(copyButton instanceof HTMLButtonElement) || !status) return;

      const requestBody = () => {
        const data = new FormData(form);
        const value = (name) => String(data.get(name) ?? '').trim();
        return [
          'Hi Tomi,',
          '',
          "I'd like the EUR 99 mcp-geo AI Visibility Audit.",
          '',
          'Brand/domain: ' + value('brand'),
          'Competitors (up to 3): ' + value('competitors'),
          'Context or priority (optional): ' + value('context'),
          '',
          'Source: mcp-geo audit page',
        ].join('\\n');
      };

      const validate = () => {
        if (form.reportValidity()) return true;
        status.textContent = 'Add your brand/domain first.';
        return false;
      };

      const mailtoForRequest = () =>
        'mailto:${AUDIT_EMAIL}?subject=' +
        encodeURIComponent('${AUDIT_SUBJECT}') +
        '&body=' +
        encodeURIComponent(requestBody());

      const copyText = async (text) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          try {
            await navigator.clipboard.writeText(text);
            return;
          } catch {
            // Fall through to the legacy copy path for restrictive browsers.
          }
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('copy command failed');
      };

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!validate()) return;
        status.textContent = 'Opening your email app. If nothing happens, use Copy request details.';
        window.location.href = mailtoForRequest();
      });

      copyButton.addEventListener('click', async () => {
        if (!validate()) return;
        const copyPayload =
          'To: ${AUDIT_EMAIL}\\nSubject: ${AUDIT_SUBJECT}\\n\\n' + requestBody();
        try {
          await copyText(copyPayload);
          status.textContent = 'Request copied - email it to ${AUDIT_EMAIL}.';
        } catch {
          status.textContent = 'Copy failed. Email ${AUDIT_EMAIL} directly.';
        }
      });
    })();
  </script>
</body>
</html>`;
}

export function handlePublicAudit(request: Request): Response | null {
  const url = new URL(request.url);
  if (!['/', '/audit', '/robots.txt', '/sitemap.xml'].includes(url.pathname)) {
    return null;
  }

  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET' },
    });
  }

  if (url.pathname === '/robots.txt') {
    return new Response(ROBOTS_BODY, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (url.pathname === '/') {
    return new Response(publicRootText(url.origin), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (url.pathname === '/sitemap.xml') {
    return new Response(SITEMAP_BODY, {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  return new Response(auditHtml(url.origin), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}
