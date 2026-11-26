// Per-brand search market. A brand stores one market as a BCP 47 locale
// ('pl-PL': language-COUNTRY) plus the Google domain to sample. Every run
// records the market it was scanned in, and history reads only the
// brand's current market (CURRENT_MARKET_SQL in src/db/types.ts).

// The fork's default: Poland first (memo decision 18).
export const DEFAULT_MARKET = 'pl-PL';
export const DEFAULT_GOOGLE_DOMAIN = 'google.pl';

const MARKET_RE = /^[a-z]{2}-[A-Z]{2}$/;
const GOOGLE_DOMAIN_RE = /^google\.[a-z]{2,3}(\.[a-z]{2})?$/;

export interface Market {
  market: string;
  language: string; // hl
  country: string; // gl, lowercase
  google_domain: string;
}

export function isMarket(value: string): boolean {
  return MARKET_RE.test(value);
}

export function isGoogleDomain(value: string): boolean {
  return GOOGLE_DOMAIN_RE.test(value);
}

// Brands built in memory (tests, older callers) may lack the fields; the
// stored columns are NOT NULL with the same defaults.
export function brandMarket(brand: { market?: string; google_domain?: string }): Market {
  const market = brand.market ?? DEFAULT_MARKET;
  const [language, country] = market.split('-');
  return {
    market,
    language,
    country: country.toLowerCase(),
    google_domain: brand.google_domain ?? DEFAULT_GOOGLE_DOMAIN,
  };
}
