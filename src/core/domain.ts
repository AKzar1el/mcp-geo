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
  if (s.startsWith('www.')) s = s.slice(4);
  if (s.length === 0 || s.length > 253) return null;
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
