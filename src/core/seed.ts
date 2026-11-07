// Brand seeding, shared by the Worker's POST /admin/seed route and the
// local CLI's track_brand tool. Creates the user + brand rows
// (INSERT OR IGNORE — existing rows are never clobbered), then
// uses three provider-free starter prompts by default. Claude Haiku
// prompt generation requires an explicit opt-in at brand creation.

import type { Db, NewPromptInput } from '../db/types.js';
import {
  DomainInputError,
  normalizeCompetitorDomains,
  normalizeRequiredDomain,
} from './domain.js';
import { generatePrompts } from './prompt-generation.js';

const DEFAULT_USER_ID = 'dev-user';
const DEFAULT_USER_EMAIL = 'dev@local';

// Used by default and when explicitly requested generation fails, so
// the brand always has something to query against.
// Lightweight category-anchored starting points, not a validated prompt
// sample. $CATEGORY uses the supplied category (or the brand name if absent,
// in which case clients must not treat scores as category-level visibility).
const FALLBACK_PROMPTS: NewPromptInput[] = [
  {
    text: 'best tools for $CATEGORY',
    intent_stage: 'awareness',
    shape: 'best X',
  },
  {
    text: 'top alternatives in $CATEGORY',
    intent_stage: 'comparison',
    shape: 'alternatives to X',
  },
  {
    text: 'most popular $CATEGORY options for small teams',
    intent_stage: 'awareness',
    shape: 'X for Y',
  },
];

function substituteFallbackPlaceholders(
  prompts: NewPromptInput[],
  categoryOrName: string,
): NewPromptInput[] {
  return prompts.map((p) => ({
    ...p,
    text: p.text.replaceAll('$CATEGORY', categoryOrName),
  }));
}

export interface SeedBrandInput {
  brand_id: string;
  name: string;
  domain: string;
  prompt_generation?: 'fallback' | 'anthropic';
  category?: string;
  competitors?: string[];
  refresh_frequency?: 'daily' | 'weekly' | 'manual';
  // Extra terms that always count as a brand mention.
  aliases?: string[];
  // Terms suppressed from the bare-word match on the brand name and
  // domain root (homograph brands like Monday/Notion).
  exclude_terms?: string[];
}

export interface SeedResult {
  seeded: boolean;
  brand_id: string;
  reason?: string;
  prompts_inserted?: number;
  prompt_source?: 'generated' | 'fallback';
  starter_prompt_limitations?: string;
}

export interface SeedDeps {
  db: Db;
  ANTHROPIC_API_KEY?: string;
}

// Pass any brand identity via SeedBrandInput; an empty/missing input
// returns cleanly with no DB writes so an empty POST to /admin/seed
// (or a malformed tool call) is a safe no-op. Example payload:
//   { "brand_id": "acme",
//     "name": "Acme Project Tool",
//     "domain": "acme.com",
//     "category": "Project management software",
//     "competitors": ["asana.com", "monday.com"] }
export async function seedBrand(
  deps: SeedDeps,
  input: SeedBrandInput | null,
  promptCount = 20,
): Promise<SeedResult> {
  if (!input || !input.brand_id || !input.name || !input.domain) {
    console.error('seedBrand: no brand to seed, exiting');
    return {
      seeded: false,
      brand_id: input?.brand_id ?? '',
      reason: 'no brand payload provided',
    };
  }

  const name = input.name.trim();
  if (!name) {
    throw new DomainInputError('name must not be empty');
  }

  if (
    input.refresh_frequency !== undefined &&
    input.refresh_frequency !== 'daily' &&
    input.refresh_frequency !== 'weekly' &&
    input.refresh_frequency !== 'manual'
  ) {
    throw new DomainInputError(
      'refresh_frequency must be daily, weekly, or manual',
    );
  }
  if (
    input.prompt_generation !== undefined &&
    input.prompt_generation !== 'fallback' &&
    input.prompt_generation !== 'anthropic'
  ) {
    throw new DomainInputError(
      'prompt_generation must be fallback or anthropic',
    );
  }

  const domain = normalizeRequiredDomain(input.domain);
  const competitors = normalizeCompetitorDomains(
    input.competitors ?? [],
    domain,
  );

  const existing = await deps.db.getBrand(input.brand_id);
  if (existing) {
    return {
      seeded: false,
      brand_id: input.brand_id,
      reason: 'already exists',
    };
  }
  if (input.prompt_generation === 'anthropic' && !deps.ANTHROPIC_API_KEY) {
    throw new DomainInputError(
      'prompt_generation=anthropic requires ANTHROPIC_API_KEY',
    );
  }

  const category = input.category?.trim() || null;

  await deps.db.upsertUser(DEFAULT_USER_ID, DEFAULT_USER_EMAIL);
  await deps.db.createBrand({
    id: input.brand_id,
    user_id: DEFAULT_USER_ID,
    domain,
    name,
    category,
    competitors,
    aliases: input.aliases ?? [],
    exclude_terms: input.exclude_terms ?? [],
    refresh_frequency: input.refresh_frequency ?? 'weekly',
  });

  const brand = await deps.db.getBrand(input.brand_id);
  if (!brand) {
    throw new Error('seedBrand: brand insert apparently failed');
  }

  if (input.prompt_generation === 'anthropic') {
    try {
      const generated = await generatePrompts(
        { db: deps.db, ANTHROPIC_API_KEY: deps.ANTHROPIC_API_KEY },
        brand,
        promptCount,
      );
      return {
        seeded: true,
        brand_id: input.brand_id,
        prompts_inserted: generated.length,
        prompt_source: 'generated',
      };
    } catch (err) {
      console.warn('seedBrand: generator failed, using fallback prompts', {
        brand_id: input.brand_id,
        message: (err as Error).message,
      });
    }
  }
  const fallback = substituteFallbackPlaceholders(
    FALLBACK_PROMPTS,
    brand.category ?? brand.name,
  );
  await deps.db.replacePrompts(input.brand_id, fallback);
  return {
    seeded: true,
    brand_id: input.brand_id,
    prompts_inserted: fallback.length,
    prompt_source: 'fallback',
    starter_prompt_limitations: brand.category
      ? 'Three provider-free category-anchored prompts are only a small starter sample, not validated buyer-intent coverage. Inspect and customize the active prompts before interpreting visibility trends.'
      : 'No category was provided, so the three starter prompts use the brand name as a placeholder. This can bias brand-mention results and is not a valid independent category-visibility baseline. Set the category and replace prompts before scanning.',
  };
}
