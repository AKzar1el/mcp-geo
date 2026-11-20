const AUDIT_EMAIL = 'info@tomiseregi.si';
const AUDIT_SUBJECT = 'mcp-geo AI Visibility Audit - EUR 99';
const PUBLIC_ORIGIN = 'https://geo-mcp.digestseo.com';
const AUDIT_URL = `${PUBLIC_ORIGIN}/audit`;
const PRIVACY_URL = `${PUBLIC_ORIGIN}/privacy`;
const SAMPLE_REPORT_URL =
  'https://github.com/AKzar1el/mcp-geo/blob/main/docs/demo-report-full.png';
const AUDIT_METHODOLOGY_URL =
  'https://github.com/AKzar1el/mcp-geo/blob/main/docs/ai-visibility-audit-methodology.md';
const AUDIT_DESCRIPTION =
  'A one-time AI Visibility Audit using mcp-geo: 20 buyer-intent prompts, competitor comparison, citation evidence, and prioritized next actions.';
const AUDIT_BODY = `Hi Tomi,

I'd like the EUR 99 mcp-geo AI Visibility Audit.

Brand/domain:
Category / product type:
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
    'Run the local MCP server with your own provider keys:\n' +
    'npx -y @digestseo/mcp-geo\n\n' +
    'For remote MCP, self-host a configured Worker from:\n' +
    'https://github.com/AKzar1el/mcp-geo/blob/main/SETUP.md\n' +
    'The public DigestSEO Worker is not a turnkey fresh-scan service.\n\n' +
    'EUR 99 AI Visibility Audit:\n' +
    `${origin}/audit\n`
  );
}

const PRIVACY_BODY = `mcp-geo Privacy Policy

Scope
This policy covers the local mcp-geo package and Claude Desktop extension.

Data use and storage
Brand configuration, prompts, scan runs, responses, and cached responses are used only to provide the MCP features you invoke. Local data is stored in the SQLite database at ~/.digestseo/digestseo.sqlite unless you set DIGESTSEO_DB_PATH. mcp-geo does not operate an account service and does not send telemetry or analytics to the project author.

Third-party processing
Prompt and scan traffic is sent only to the AI providers whose API keys you configure: OpenAI, Anthropic, Google, Perplexity, xAI, and/or SerpAPI. Those providers process and retain that traffic under their own privacy policies. The project author does not receive copies of that provider traffic.

Retention and deletion
Local data remains on your machine until you delete the SQLite database or the custom DIGESTSEO_DB_PATH you configured. Deleting that local database removes mcp-geo's stored local history and cache. Provider-side retention is controlled by each configured provider.

Contact
Privacy questions about mcp-geo can be sent to info@tomiseregi.si.
`;

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
    .request-preview { max-height: 280px; overflow: auto; margin: 0; padding: 16px; border: 1px solid #343b45; border-radius: 8px; background: #0b0d10; color: #dce2e8; font: 13px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
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
    <p class="proof"><strong>Methodology:</strong> The same 20 buyer-intent prompts are run as a point-in-time diagnostic and reported per engine, with citation/source evidence where the provider returns it. The report is a bounded observed snapshot, not a proprietary ranking promise or guaranteed forecast. <a href="${AUDIT_METHODOLOGY_URL}">See the exact score calculation and interpretation limits.</a></p>

    <form id="audit-request-form" class="request-card">
      <label>
        Brand/domain
        <input name="brand" type="text" autocomplete="url" placeholder="example.com" required>
      </label>
      <label>
        Category / product type
        <input name="category" type="text" placeholder="Project management software" required>
      </label>
      <label>
        Competitors (up to 3)
        <textarea name="competitors" rows="3" placeholder="competitor-one.com, competitor-two.com"></textarea>
      </label>
      <p class="fine">Separate competitors with commas, semicolons or new lines. Pasted URLs are reduced to domain names in the request, so paths, login details and tracking parameters are not emailed. Add relevant page details in Context instead.</p>
      <label>
        Context or priority (optional)
        <textarea name="context" placeholder="What market, product, or buyer journey matters most?"></textarea>
      </label>
      <div class="actions">
        <button class="cta" type="submit">Request the EUR 99 audit</button>
        <button class="secondary" type="button" id="copy-request">Copy request details</button>
        <button class="secondary" type="button" id="download-request">Download request details</button>
        <button class="secondary" type="button" id="preview-request" aria-controls="request-preview-body" aria-expanded="false">Preview request details</button>
      </div>
      <pre id="request-preview-body" class="request-preview" hidden aria-label="Prepared email request"></pre>
      <p id="request-status" class="status" role="status" aria-live="polite"></p>
    </form>

    <p class="fine">After you email the request, Tomi will confirm fit and scope by email, then use the existing invoice and payment process. This page does not collect payment details.</p>
    <p class="fine">Implementation is not included; the prioritized action memo is intended for your own team or existing provider to execute.</p>
    <p class="fine">Email <a href="mailto:${AUDIT_EMAIL}">${AUDIT_EMAIL}</a> directly if your browser does not open an email app. No subscription, no sales call required. The audit does not guarantee rankings, citations, traffic, or commercial outcomes.</p>
    <a class="cta" href="${mailto}">Email the EUR 99 audit request</a>
    <noscript><p class="fine">JavaScript is optional. You can still <a href="${mailto}">email the prefilled audit request</a> directly.</p></noscript>

    <p class="oss">Prefer to run it yourself? <strong>mcp-geo remains free and open-source under MIT.</strong> Use the local npm package, or follow the self-hosting instructions to deploy your own configured Worker. Source and setup instructions are on <a href="https://github.com/AKzar1el/mcp-geo">GitHub</a>.</p>
  </main>
  <script>
    (() => {
      const form = document.getElementById('audit-request-form');
      const copyButton = document.getElementById('copy-request');
      const downloadButton = document.getElementById('download-request');
      const previewButton = document.getElementById('preview-request');
      const previewBody = document.getElementById('request-preview-body');
      const status = document.getElementById('request-status');
      if (!(form instanceof HTMLFormElement) ||
          !(copyButton instanceof HTMLButtonElement) ||
          !(downloadButton instanceof HTMLButtonElement) ||
          !(previewButton instanceof HTMLButtonElement) || !previewBody || !status) return;

      const domainForRequest = (input) => {
        const raw = input.trim();
        const isUrl = raw.includes('://');
        try {
          const candidate = isUrl ? raw : 'https://' + raw;
          const url = new URL(candidate);
          if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.')) {
            const host = url.hostname.toLowerCase().replace(/[.]$/, '').replace(/^www[.]/, '');
            const labels = host.split('.');
            // WHATWG URL accepts repeated dots, invalid DNS labels and numeric IPs.
            // Match the backend's public-domain requirements before offering an audit.
            const isIpv4 = /^(?:[0-9]{1,3}[.]){3}[0-9]{1,3}$/.test(host);
            if (host.length <= 253 && labels.length >= 2 && !isIpv4 &&
                labels.every((label) => label.length <= 63 &&
                  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
              return host;
            }
          }
        } catch {
          // Preserve free-form brand names rather than turning them into invalid domains.
        }
        // A broken scheme-less URL can otherwise leak paths or credential values
        // into mailto, preview, clipboard, and downloaded request details.
        const hasUrlSyntax = isUrl || /[?#@]/.test(raw) ||
          (raw.includes('.') && (/[/:]/.test(raw) || !/\\s/.test(raw)));
        return hasUrlSyntax ? '' : raw;
      };

      const parseCompetitors = (input) => {
        const entries = [];
        let start = 0;
        for (let index = 0; index < input.length; index++) {
          const delimiter = input[index];
          if (delimiter !== ',' && delimiter !== ';' && delimiter !== '\\r' && delimiter !== '\\n') continue;
          const segment = input.slice(start, index).trim();
          // Literal line breaks separate pasted competitors, never URL query data.
          if (delimiter === '\\r' || delimiter === '\\n') {
            entries.push(segment);
            start = index + 1;
            continue;
          }
          // URL paths, queries and fragments can contain list punctuation.
          // Without a space or another URL prefix, keep it inside the URL.
          const isUrlData = /^(?:https?:\\/\\/)?(?:[^/?#\\s,;]+[.])+[^/?#\\s,;]+[/?#]/i.test(segment);
          const startsNextEntry = /^\\s|^https?:\\/\\//i.test(input.slice(index + 1));
          if (isUrlData && !startsNextEntry) continue;
          entries.push(segment);
          start = index + 1;
        }
        entries.push(input.slice(start).trim());
        return entries.filter(Boolean);
      };

      const requestBody = () => {
        const data = new FormData(form);
        const value = (name) => String(data.get(name) ?? '').trim();
        const competitors = parseCompetitors(value('competitors'));
        return [
          'Hi Tomi,',
          '',
          "I'd like the EUR 99 mcp-geo AI Visibility Audit.",
          '',
          'Brand/domain: ' + domainForRequest(value('brand')),
          'Category / product type: ' + value('category'),
          'Competitors (up to 3): ' + competitors.map(domainForRequest).join(', '),
          'Context or priority (optional): ' + value('context'),
          '',
          'Source: mcp-geo audit page',
        ].join('\\n');
      };

      const validate = () => {
        if (!form.reportValidity()) {
          status.textContent = 'Add your brand/domain and category first.';
          return false;
        }
        const data = new FormData(form);
        const value = (name) => String(data.get(name) ?? '').trim();
        if (!value('brand') || !value('category')) {
          status.textContent = 'Add your brand/domain and category first.';
          return false;
        }
        const competitors = parseCompetitors(value('competitors'));
        if (competitors.length > 3) {
          status.textContent = 'This audit covers up to 3 competitors. Remove extras or email us about a different scope.';
          return false;
        }
        if ([value('brand'), ...competitors].some((entry) => !domainForRequest(entry))) {
          status.textContent = 'Enter a valid brand name, public domain or HTTP(S) URL for the brand and each competitor.';
          return false;
        }
        // Compare the same canonical domain that goes into the request.
        const comparisonDomain = (entry) => domainForRequest(entry).toLowerCase();
        const competitorDomains = competitors.map(comparisonDomain);
        if (new Set(competitorDomains).size !== competitorDomains.length ||
            competitorDomains.includes(comparisonDomain(value('brand')))) {
          status.textContent = 'Use distinct competitor domains that differ from your own brand/domain.';
          return false;
        }
        return true;
      };

      const mailtoForRequest = () =>
        'mailto:${AUDIT_EMAIL}?subject=' +
        encodeURIComponent('${AUDIT_SUBJECT}') +
        '&body=' +
        encodeURIComponent(requestBody());

      const requestMessage = () =>
        'To: ${AUDIT_EMAIL}\\nSubject: ${AUDIT_SUBJECT}\\n\\n' + requestBody();

      const hidePreview = () => {
        previewBody.hidden = true;
        previewBody.textContent = '';
        previewButton.setAttribute('aria-expanded', 'false');
      };
      // Never leave a previously prepared email visible after the inputs change.
      form.addEventListener('input', hidePreview);
      previewButton.addEventListener('click', () => {
        if (!previewBody.hidden) {
          hidePreview();
          return;
        }
        if (!validate()) return;
        previewBody.textContent = requestMessage();
        previewBody.hidden = false;
        previewButton.setAttribute('aria-expanded', 'true');
      });

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
        let copied = false;
        try {
          textarea.select();
          copied = document.execCommand('copy');
        } finally {
          textarea.remove();
        }
        if (!copied) throw new Error('copy command failed');
      };

      const copyRequestDetails = async () => {
        const preparedRequest = requestMessage();
        try {
          await copyText(preparedRequest);
          if (preparedRequest !== requestMessage()) {
            status.textContent = 'Request changed while copying. Copy again before emailing the updated details.';
            return 'stale';
          }
          status.textContent = 'Request copied - email it to ${AUDIT_EMAIL}.';
          return 'copied';
        } catch {
          status.textContent = 'Copy failed. Use Download request details to save the complete request, then email it to ${AUDIT_EMAIL}.';
          return 'failed';
        }
      };

      const downloadRequestDetails = () => {
        let blobUrl;
        let link;
        try {
          const blob = new Blob([requestMessage()], { type: 'text/plain;charset=utf-8' });
          blobUrl = URL.createObjectURL(blob);
          link = document.createElement('a');
          link.href = blobUrl;
          link.download = 'mcp-geo-audit-request.txt';
          document.body.appendChild(link);
          link.click();
          status.textContent = 'Request file downloaded. Email its contents to ${AUDIT_EMAIL}; downloading does not submit the request.';
        } catch {
          status.textContent = 'Download failed. Email ${AUDIT_EMAIL} directly with your request details.';
        } finally {
          if (link) link.remove();
          if (blobUrl) URL.revokeObjectURL(blobUrl);
        }
      };

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!validate()) return;
        const emailLink = mailtoForRequest();
        // Long mailto URLs can be truncated or rejected by email clients.
        // Preserve the complete request without sending it to any server.
        if (emailLink.length > 1800) {
          const copyResult = await copyRequestDetails();
          status.textContent = copyResult === 'copied'
            ? 'Email link too long; request copied. Paste it into an email to ${AUDIT_EMAIL}.'
            : copyResult === 'stale'
              ? 'Email link too long; request changed while copying. Copy again before emailing the updated details.'
              : 'Email link too long and copy failed. Use Download request details, then email the saved request to ${AUDIT_EMAIL}.';
          return;
        }
        status.textContent = 'Opening your email app. If nothing happens, use Copy or Download request details.';
        try {
          window.location.href = emailLink;
        } catch {
          // Some embedded or locked-down browsers reject external mail handlers.
          status.textContent = 'Could not open your email app. Use Copy or Download request details, then email the request to ${AUDIT_EMAIL}.';
        }
      });

      copyButton.addEventListener('click', async () => {
        if (!validate()) return;
        await copyRequestDetails();
      });
      downloadButton.addEventListener('click', () => {
        if (!validate()) return;
        downloadRequestDetails();
      });
    })();
  </script>
</body>
</html>`;
}

export function handlePublicAudit(request: Request): Response | null {
  const url = new URL(request.url);
  const hasCanonicalSlashAlias =
    url.pathname === '/audit/' || url.pathname === '/privacy/';
  if (
    !hasCanonicalSlashAlias &&
    !['/', '/audit', '/privacy', '/robots.txt', '/sitemap.xml'].includes(url.pathname)
  ) {
    return null;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }

  if (hasCanonicalSlashAlias) {
    url.pathname = url.pathname.slice(0, -1);
    return Response.redirect(url.toString(), 308);
  }

  const isHead = request.method === 'HEAD';

  if (url.pathname === '/robots.txt') {
    return new Response(isHead ? null : ROBOTS_BODY, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (url.pathname === '/') {
    return new Response(isHead ? null : publicRootText(url.origin), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (url.pathname === '/sitemap.xml') {
    return new Response(isHead ? null : SITEMAP_BODY, {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (url.pathname === '/privacy') {
    return new Response(isHead ? null : PRIVACY_BODY, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  return new Response(isHead ? null : auditHtml(url.origin), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}
