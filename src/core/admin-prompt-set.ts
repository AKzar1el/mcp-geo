import type { Db } from '../db/types.js';
import { applyExactPromptSet } from './prompt-set.js';
import {
  updateTrackedBrand,
  type UpdateTrackedBrandInput,
} from './update-brand.js';

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
      aliases: brand.aliases,
      exclude_terms: brand.exclude_terms,
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

export async function handleAdminUpdateBrand(
  request: Request,
  db: Db,
): Promise<Response> {
  let body: Record<string, unknown> | null = null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const brandId = body?.brand_id;
  if (typeof brandId !== 'string' || !brandId) {
    return jsonResponse({ error: 'brand_id required' }, 400);
  }

  const stringFields = ['name', 'domain'] as const;
  for (const field of stringFields) {
    if (body[field] !== undefined && typeof body[field] !== 'string') {
      return jsonResponse({ error: `${field} must be a string` }, 400);
    }
  }
  if (
    body.category !== undefined &&
    body.category !== null &&
    typeof body.category !== 'string'
  ) {
    return jsonResponse({ error: 'category must be a string or null' }, 400);
  }
  for (const field of ['competitors', 'aliases', 'exclude_terms'] as const) {
    if (
      body[field] !== undefined &&
      (!Array.isArray(body[field]) ||
        !(body[field] as unknown[]).every((value) => typeof value === 'string'))
    ) {
      return jsonResponse({ error: `${field} must be an array of strings` }, 400);
    }
  }
  if (
    body.refresh_frequency !== undefined &&
    body.refresh_frequency !== 'daily' &&
    body.refresh_frequency !== 'weekly'
  ) {
    return jsonResponse(
      { error: 'refresh_frequency must be either daily or weekly' },
      400,
    );
  }

  const input: UpdateTrackedBrandInput = {
    brand_id: brandId,
    name: body.name as string | undefined,
    domain: body.domain as string | undefined,
    category: body.category as string | null | undefined,
    competitors: body.competitors as string[] | undefined,
    aliases: body.aliases as string[] | undefined,
    exclude_terms: body.exclude_terms as string[] | undefined,
    refresh_frequency: body.refresh_frequency as 'daily' | 'weekly' | undefined,
  };

  try {
    const result = await updateTrackedBrand(db, input);
    return jsonResponse({
      updated: result.updated,
      brand_id: result.brand_id,
      changed_fields: result.changed_fields,
      brand: {
        name: result.brand.name,
        domain: result.brand.domain,
        category: result.brand.category,
        competitors: result.brand.competitors,
        aliases: result.brand.aliases,
        exclude_terms: result.brand.exclude_terms,
        refresh_frequency: result.brand.refresh_frequency,
      },
      next_steps: `POST /admin/run-live with brand_id '${brandId}' to scan using the updated brand metadata. Active prompts and historical runs were preserved.`,
    });
  } catch (err) {
    const message = (err as Error).message;
    return jsonResponse({ error: message }, message === 'brand not found' ? 404 : 400);
  }
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
