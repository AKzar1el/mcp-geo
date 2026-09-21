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
