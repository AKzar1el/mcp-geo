// Shoper egress proxy client (shoper-growth-mcp decision 27): Shoper answers
// 421 to every Cloudflare Worker subrequest, so storefront fetches for the
// site audit go through a signed Cloud Run proxy. TypeScript copy of
// shoper-growth-mcp proxy/sign.mjs + src/commerce/shoper/egress.ts; the
// signature must stay byte-identical (tests/unit/egress.test.ts pins a vector).

const enc = new TextEncoder();
const hex = (buf: ArrayBufferLike) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const MAX_REDIRECTS = 5;

export const newNonce = () => hex(crypto.getRandomValues(new Uint8Array(16)).buffer);

/** HMAC-SHA256 over timestamp, nonce, method, host, path+query and the body's SHA-256 (always empty: GET only), as hex. */
export async function signature(
  key: string,
  p: { ts: string; nonce: string; method: string; host: string; path: string },
): Promise<string> {
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', new Uint8Array()));
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode([p.ts, p.nonce, p.method, p.host, p.path, bodyHash].join('\n'))));
}

/** The proxy itself refused the call (bad key, stale clock, host not allowlisted). */
export class EgressError extends Error {}

/**
 * GET-only fetch through the proxy; the target travels in signed headers.
 * Redirects are followed here, through the proxy again.
 */
export function egressFetch(proxyUrl: string, key: string, f: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (!key) throw new EgressError('SHOPER_PROXY_URL is set but SHOPER_PROXY_KEY is missing: run `npx wrangler secret put SHOPER_PROXY_KEY` with the shoper-proxy-key value');
    const req = new Request(input, init);
    if (req.method !== 'GET') throw new EgressError(`egressFetch supports GET only, got ${req.method}`);
    const headers = new Headers(req.headers);
    let url = new URL(req.url);
    for (let hop = 0; ; hop++) {
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = newNonce();
      const path = url.pathname + url.search;
      headers.set('x-egress-ts', ts);
      headers.set('x-egress-nonce', nonce);
      headers.set('x-egress-host', url.host);
      headers.set('x-egress-path', path);
      headers.set('x-egress-sig', await signature(key, { ts, nonce, method: 'GET', host: url.host, path }));
      const res = await f(proxyUrl, { method: 'GET', headers, redirect: 'manual', signal: req.signal });
      if (res.headers.get('x-egress-error')) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        throw new EgressError(`Egress proxy refused the call (${res.status}): ${error ?? res.statusText}. Check SHOPER_PROXY_KEY and that ${url.host} is in the proxy's ALLOWED_HOSTS (shoper-growth-mcp proxy/deploy.sh).`);
      }
      const location = res.headers.get('location');
      if (res.status < 300 || res.status > 399 || !location) return res;
      await res.body?.cancel(); // Workers allow only 6 open connections
      if (hop >= MAX_REDIRECTS) throw new EgressError(`More than ${MAX_REDIRECTS} redirects from ${url.host}`);
      url = new URL(location, url);
    }
  };
}
