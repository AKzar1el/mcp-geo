import type { Db } from '../db/types.js';
import { applyExactPromptSet } from './prompt-set.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function handleAdminSetPrompts(
  request: Request,
  db: Db,
): Promise<Response> {
  let body: { brand_id?: string; prompts?: unknown } | null = null;
  try {
    body = (await request.json()) as { brand_id?: string; prompts?: unknown };
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const brandId = body?.brand_id;
  if (!brandId) {
    return jsonResponse({ error: 'brand_id required' }, 400);
  }
  if (
    !Array.isArray(body?.prompts) ||
    !body.prompts.every((prompt) => typeof prompt === 'string')
  ) {
    return jsonResponse({ error: 'prompts must be an array of strings' }, 400);
  }

  const brand = await db.getBrand(brandId);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);

  try {
    const result = await applyExactPromptSet(db, brandId, body.prompts);
    return jsonResponse({
      brand_id: brandId,
      ...result,
      next_steps: `POST /admin/run-live with brand_id '${brandId}' to scan this prompt set.`,
    });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 400);
  }
}

export async function handleAdminListBrands(db: Db): Promise<Response> {
  const brands = await db.listBrands();
  return jsonResponse({
    brands: brands.map((brand) => ({
      brand_id: brand.id,
      name: brand.name,
      domain: brand.domain,
      category: brand.category,
      competitors: brand.competitors,
      refresh_frequency: brand.refresh_frequency,
      active_prompts: brand.active_prompts,
      created_at: new Date(brand.created_at).toISOString(),
    })),
    hint:
      brands.length === 0
        ? 'No brands tracked yet - POST /admin/seed to add one.'
        : undefined,
  });
}

export async function handleAdminListPrompts(
  request: Request,
  db: Db,
): Promise<Response> {
  const brandId = new URL(request.url).searchParams.get('brand_id');
  if (!brandId) {
    return jsonResponse({ error: 'brand_id required' }, 400);
  }

  const brand = await db.getBrand(brandId);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);

  const prompts = await db.getActivePrompts(brandId);
  return jsonResponse({
    brand_id: brandId,
    prompts: prompts.map((prompt) => ({
      id: prompt.id,
      text: prompt.text,
      intent_stage: prompt.intent_stage,
      shape: prompt.shape,
      created_at: new Date(prompt.created_at).toISOString(),
    })),
    count: prompts.length,
  });
}
