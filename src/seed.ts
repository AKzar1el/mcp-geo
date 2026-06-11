import type { Db, NewPromptInput } from './db/types.js';
import { generatePrompts } from './core/prompt-generation.js';

const DEFAULT_USER_ID = 'dev-user';
const DEFAULT_USER_EMAIL = 'dev@local';

// Used only when prompt generation fails (network/API issue) so the brand
// still has something to query against. Generic shapes; the generator
// produces category-specific prompts when it succeeds.
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

// Worker-only: seeding writes users/brands rows with raw D1 SQL (these
// inserts have no Db helper) and uses the Db contract for everything
// that does. `db` + ANTHROPIC_API_KEY also structurally satisfy
// core/prompt-generation's PromptGenEnv.
export interface SeedEnv {
  DIGESTSEO_DB: D1Database;
  db: Db;
  ANTHROPIC_API_KEY?: string;
}

// Genericized seeder. Pass any brand identity via SeedBrandInput; an
// empty/missing input returns cleanly with no DB writes so an empty POST
// to /admin/seed is a safe no-op. Example payload:
//   { "brand_id": "acme",
//     "name": "Acme Project Tool",
//     "domain": "acme.com",
//     "category": "Project management software",
//     "competitors": ["asana.com", "monday.com"] }
export async function seedBrand(
  env: SeedEnv,
  input: SeedBrandInput | null,
): Promise<SeedResult> {
  if (!input || !input.brand_id || !input.name || !input.domain) {
    console.log('seedBrand: no brand to seed, exiting');
    return {
      seeded: false,
      brand_id: input?.brand_id ?? '',
      reason: 'no brand payload provided',
    };
  }

  const existing = await env.db.getBrand(input.brand_id);
  if (existing) {
    return {
      seeded: false,
      brand_id: input.brand_id,
      reason: 'already exists',
    };
  }

  const now = Date.now();
  const competitors = input.competitors ?? [];
  const category = input.category ?? null;

  await env.DIGESTSEO_DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, plan, created_at, updated_at)
     VALUES (?, ?, 'free', ?, ?)`,
  )
    .bind(DEFAULT_USER_ID, DEFAULT_USER_EMAIL, now, now)
    .run();

  await env.DIGESTSEO_DB.prepare(
    `INSERT OR IGNORE INTO brands
       (id, user_id, domain, name, category, competitors_json,
        refresh_frequency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'weekly', ?, ?)`,
  )
    .bind(
      input.brand_id,
      DEFAULT_USER_ID,
      input.domain,
      input.name,
      category,
      JSON.stringify(competitors),
      now,
      now,
    )
    .run();

  const brand = await env.db.getBrand(input.brand_id);
  if (!brand) {
    throw new Error('seedBrand: brand insert apparently failed');
  }

  try {
    const generated = await generatePrompts(env, brand, 20);
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
    await env.db.replacePrompts(input.brand_id, FALLBACK_PROMPTS);
    return {
      seeded: true,
      brand_id: input.brand_id,
      prompts_inserted: FALLBACK_PROMPTS.length,
      prompt_source: 'fallback',
    };
  }
}
