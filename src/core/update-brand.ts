import type { Brand, Db, UpdateBrandFields } from '../db/types.js';
import {
  DomainInputError,
  normalizeCompetitorDomains,
  normalizeRequiredDomain,
} from './domain.js';
import { isGoogleDomain, isMarket } from './market.js';

export interface UpdateTrackedBrandInput {
  brand_id: string;
  name?: string;
  domain?: string;
  category?: string | null;
  competitors?: string[];
  aliases?: string[];
  exclude_terms?: string[];
  refresh_frequency?: 'daily' | 'weekly' | 'manual';
  market?: string;
  google_domain?: string;
}

export interface UpdateTrackedBrandResult {
  updated: boolean;
  brand_id: string;
  changed_fields: string[];
  prompt_set_review_recommended: boolean;
  historical_attribution_review_recommended: boolean;
  // History is per market: after a change, reads start empty until a scan
  // runs in the new market. Older runs stay stored.
  market_changed: boolean;
  brand: Brand;
}

function normalizeTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function arraysEqual(a: string[], b: string[]): boolean {
  // Matching treats competitors, aliases and exclusion terms as sets. An
  // order-only settings edit must not invalidate stored scoring attribution.
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function matchingTermsEqual(a: string[], b: string[]): boolean {
  // Matching ignores term case, but keep display-case edits as real metadata
  // updates without declaring all earlier scans to be a different identity.
  return arraysEqual(a.map((term) => term.toLowerCase()), b.map((term) => term.toLowerCase()));
}

export async function updateTrackedBrand(
  db: Db,
  input: UpdateTrackedBrandInput,
): Promise<UpdateTrackedBrandResult> {
  const existing = await db.getBrand(input.brand_id);
  if (!existing) {
    throw new Error('brand not found');
  }

  const name = input.name === undefined ? existing.name : input.name.trim();
  if (!name) throw new Error('name must not be empty');

  const domain =
    input.domain === undefined
      ? existing.domain
      : normalizeRequiredDomain(input.domain);
  const category =
    input.category === undefined
      ? existing.category
      : input.category === null
        ? null
        : input.category.trim();
  if (category === '') throw new Error('category must not be empty; use null to clear it');

  const competitorSource = input.competitors ?? existing.competitors;
  const competitors = normalizeCompetitorDomains(competitorSource, domain);
  const aliases = normalizeTerms(input.aliases ?? existing.aliases);
  const excludeTerms = normalizeTerms(input.exclude_terms ?? existing.exclude_terms);
  const refreshFrequency = input.refresh_frequency ?? existing.refresh_frequency;
  if (
    refreshFrequency !== 'daily' &&
    refreshFrequency !== 'weekly' &&
    refreshFrequency !== 'manual'
  ) {
    throw new DomainInputError('refresh_frequency must be daily, weekly, or manual');
  }

  if (input.market !== undefined && !isMarket(input.market)) {
    throw new DomainInputError("market must be a locale like 'pl-PL'");
  }
  if (input.google_domain !== undefined && !isGoogleDomain(input.google_domain)) {
    throw new DomainInputError("google_domain must look like 'google.pl'");
  }
  const market = input.market ?? existing.market;
  const googleDomain = input.google_domain ?? existing.google_domain;

  const fields: UpdateBrandFields = {
    domain,
    name,
    category,
    competitors,
    aliases,
    exclude_terms: excludeTerms,
    refresh_frequency: refreshFrequency,
    market,
    google_domain: googleDomain,
  };

  const changedFields: string[] = [];
  if (fields.name !== existing.name) changedFields.push('name');
  if (fields.domain !== existing.domain) changedFields.push('domain');
  if (fields.category !== existing.category) changedFields.push('category');
  if (!arraysEqual(fields.competitors, existing.competitors)) changedFields.push('competitors');
  if (!arraysEqual(fields.aliases, existing.aliases)) changedFields.push('aliases');
  if (!arraysEqual(fields.exclude_terms, existing.exclude_terms)) changedFields.push('exclude_terms');
  if (fields.refresh_frequency !== existing.refresh_frequency) changedFields.push('refresh_frequency');
  if (fields.market !== existing.market) changedFields.push('market');
  if (fields.google_domain !== existing.google_domain) changedFields.push('google_domain');

  const matchingIdentityChanged =
    fields.name.toLowerCase() !== existing.name.toLowerCase() ||
    fields.domain !== existing.domain ||
    !matchingTermsEqual(fields.aliases, existing.aliases) ||
    !matchingTermsEqual(fields.exclude_terms, existing.exclude_terms);

  if (changedFields.length > 0) {
    await db.updateBrand(input.brand_id, {
      ...fields,
      identity_changed: matchingIdentityChanged,
    });
  }

  const brand = changedFields.length > 0 ? await db.getBrand(input.brand_id) : existing;
  if (!brand) throw new Error('brand not found after update');

  return {
    updated: changedFields.length > 0,
    brand_id: input.brand_id,
    changed_fields: changedFields,
    prompt_set_review_recommended: changedFields.includes('category'),
    // Stored observations were scored against the old matching identity.
    historical_attribution_review_recommended: matchingIdentityChanged,
    market_changed: changedFields.includes('market'),
    brand,
  };
}
