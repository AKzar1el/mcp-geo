import type { Db } from '../db/types.js';

export interface ExactPromptSetResult {
  prompts: string[];
  prompts_inserted: number;
  changed: boolean;
}

export function normalizeExactPrompts(prompts: readonly string[]): string[] {
  if (prompts.length < 1 || prompts.length > 50) {
    throw new Error('Prompts must contain between 1 and 50 questions.');
  }
  if (prompts.some((prompt) => prompt.length > 500)) {
    throw new Error('Each prompt must be at most 500 characters.');
  }

  const normalized = prompts.map((prompt) => prompt.trim().replace(/\s+/g, ' '));
  if (normalized.some((prompt) => prompt.length === 0)) {
    throw new Error('Prompts must contain non-whitespace text.');
  }

  const normalizedKeys = normalized.map((prompt) => prompt.toLowerCase());
  if (new Set(normalizedKeys).size !== normalizedKeys.length) {
    throw new Error(
      'Prompts must be unique after trimming whitespace and ignoring case.',
    );
  }
  return normalized;
}

export async function applyExactPromptSet(
  db: Pick<Db, 'getActivePrompts' | 'replacePrompts'>,
  brandId: string,
  prompts: readonly string[],
): Promise<ExactPromptSetResult> {
  const normalized = normalizeExactPrompts(prompts);
  const current = await db.getActivePrompts(brandId);
  const unchanged =
    current.length === normalized.length &&
    current.every((prompt, index) => prompt.text === normalized[index]);

  if (!unchanged) {
    await db.replacePrompts(
      brandId,
      normalized.map((text) => ({ text, intent_stage: null, shape: null })),
    );
  }

  return {
    prompts: normalized,
    prompts_inserted: unchanged ? 0 : normalized.length,
    changed: !unchanged,
  };
}
