const AUDIT_EMAIL = 'info@tomiseregi.si';
const AUDIT_SUBJECT = 'mcp-geo AI Visibility Audit - EUR 99';
const AUDIT_BODY = `Hi Tomi,

I'd like the EUR 99 mcp-geo AI Visibility Audit.

Brand/domain:
Competitors (up to 3):
Context or priority (optional):

Source: mcp-geo audit page`;

function auditHtml(origin: string): string {
  const mailto = `mailto:${AUDIT_EMAIL}?subject=${encodeURIComponent(AUDIT_SUBJECT)}&body=${encodeURIComponent(AUDIT_BODY)}`;
  const mcpUrl = `${origin}/mcp`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mcp-geo AI Visibility Audit - EUR 99</title>
  <meta name="description" content="A one-time AI Visibility Audit using mcp-geo: 20 buyer-intent prompts, competitor comparison, citation evidence, and prioritized next actions.">
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
    .cta { display: inline-block; padding: 14px 20px; border-radius: 8px; background: #f4f6f8; color: #0b0d10; font-weight: 800; text-decoration: none; }
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
      <li>A prioritized content-gap and action memo grounded in the observed prompt results.</li>
      <li>Target delivery within two business days after usable brand and competitor input is received.</li>
    </ul>

    <a class="cta" href="${mailto}">Request the EUR 99 audit</a>
    <p class="fine">Email ${AUDIT_EMAIL}. No subscription, no sales call required. The audit does not guarantee rankings, citations, traffic, or commercial outcomes.</p>

    <p class="oss">Prefer to run it yourself? <strong>mcp-geo remains free and open-source under MIT.</strong> Use the local npm package or connect to the MCP endpoint at <a href="${mcpUrl}">${mcpUrl}</a>. Source and setup instructions are on <a href="https://github.com/AKzar1el/mcp-geo">GitHub</a>.</p>
  </main>
</body>
</html>`;
}

export function handlePublicAudit(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== '/audit') return null;

  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET' },
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
