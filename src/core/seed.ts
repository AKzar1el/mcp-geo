// Brand seeding, shared by the Worker's POST /admin/seed route and the
// local CLI's track_brand tool. Creates the user + brand rows
// (INSERT OR IGNORE — existing rows are never clobbered), then
// generates buyer-intent prompts via Claude Haiku when an Anthropic key
// is available, falling back to three generic prompts otherwise so the
// brand is immediately scannable.

import type { Db, NewPromptInput } from '../db/types.js';
import { generatePrompts } from './prompt-generation.js';

const DEFAULT_USER_ID = 'dev-user';
const DEFAULT_USER_EMAIL = 'dev@local';

// Used only when prompt generation fails (no ANTHROPIC_API_KEY,
// network/API issue) so the brand still has something to query against.
// Generic shapes; the generator produces category-specific prompts when
// it succeeds. $CATEGORY is substituted with the brand's category (or
// its name when no category was given) before insert.
const FALLBACK_PROMPTS: NewPromptInput[] = [
  {
    text: 'best tools for $CATEGORY',
    intent_stage: 'awareness',
    shape: 'best X',
  },
  {
    text: 'top alternatives to leading products in this space',
    intent_stage: 'comparison',
    shape: 'alternatives to X',
  },
  {
    text: 'most popular options for small teams',
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
  category?: string;
  competitors?: string[];
}

export interface SeedResult {
  seeded: boolean;
  brand_id: string;
  reason?: string;
  prompts_inserted?: number;
  prompt_source?: 'generated' | 'fallback';
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

  const existing = await deps.db.getBrand(input.brand_id);
  if (existing) {
    return {
      seeded: false,
      brand_id: input.brand_id,
      reason: 'already exists',
    };
  }

  const competitors = input.competitors ?? [];
  const category = input.category ?? null;

  await deps.db.upsertUser(DEFAULT_USER_ID, DEFAULT_USER_EMAIL);
  await deps.db.createBrand({
    id: input.brand_id,
    user_id: DEFAULT_USER_ID,
    domain: input.domain,
    name: input.name,
    category,
    competitors,
    refresh_frequency: 'weekly',
  });

  const brand = await deps.db.getBrand(input.brand_id);
  if (!brand) {
    throw new Error('seedBrand: brand insert apparently failed');
  }

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
    };
  }
}
