// Canonical host form used for stored brand and competitor domains. It
// matches citation host comparison: lowercase, without scheme, port, path,
// query, fragment, or a leading www.

export class DomainInputError extends Error {}

// 'https://www.Acme.com/pricing?x=1' -> 'acme.com'. Returns null when the
// input doesn't reduce to something domain-shaped.
export function normalizeDomainInput(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split('/')[0] ?? s; // path
  s = s.split('?')[0] ?? s; // query without a path
  s = s.split('#')[0] ?? s; // fragment without a path
  s = s.replace(/:\d+$/, ''); // port
  // WHATWG URL applies IDNA normalization consistently in Node and Workers.
  // Check the original host first: URL parsing also accepts encoded or
  // authority-like syntax that should never be treated as a domain input.
  if (!/^[\p{L}\p{M}\p{N}.-]+$/u.test(s)) return null;
  try {
    s = new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
  // WHATWG URL also canonicalizes hex/octal IPv4 spellings. These are hosts,
  // not brand domains, and would waste paid visibility scans.
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(s)) return null;
  // Remove www after IDNA folds Unicode compatibility equivalents of its letters.
  if (s.startsWith('www.')) s = s.slice(4);
  if (s.length === 0 || s.length > 253) return null;
  // The whole hostname may fit while an individual ASCII/IDNA DNS label
  // exceeds the 63-octet wire limit. Validate after URL's IDNA conversion.
  if (s.split('.').some((label) => label.length > 63)) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    return null;
  }
  return s;
}

export function normalizeRequiredDomain(raw: string): string {
  const domain = normalizeDomainInput(raw);
  if (!domain) {
    throw new DomainInputError(
      `'${raw}' does not look like a domain. Pass a bare domain like 'acme.com' (no scheme or path needed).`,
    );
  }
  return domain;
}

export function normalizeCompetitorDomains(
  rawCompetitors: string[],
  primaryDomain: string,
): string[] {
  const competitors: string[] = [];
  for (const raw of rawCompetitors) {
    const domain = normalizeDomainInput(raw);
    if (!domain) {
      throw new DomainInputError(
        `Competitor '${raw}' does not look like a domain. Pass bare domains like 'asana.com'.`,
      );
    }
    if (domain !== primaryDomain && !competitors.includes(domain)) {
      competitors.push(domain);
    }
  }
  return competitors;
}
