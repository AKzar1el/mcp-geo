// Dynamic prompt generation via Claude Haiku. Replaces the hardcoded
// list seedTestBrand used to ship.
//
// Contract: on success, replaces ALL existing prompts for the brand
// (DELETE WHERE brand_id then INSERT new ones) via replacePrompts.
// On failure (network, parse, validation), throws without touching the
// DB so callers can fall back or retry.

import { chatCompletion as anthropicChat } from './anthropic.js';
import type { Brand, Db, NewPromptInput } from '../db/types.js';

export interface PromptGenEnv {
  db: Db;
  ANTHROPIC_API_KEY?: string;
}

function requireAnthropicKey(env: PromptGenEnv): string {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — prompt generation requires Claude Haiku');
  }
  return env.ANTHROPIC_API_KEY;
}

const BASE_SYSTEM_PROMPT = [
  'You generate commercial-intent search prompts that potential buyers would ask an AI assistant when researching a category.',
  'Return a JSON array only — no prose, no markdown fences.',
  'Each item: { "prompt": string, "intent_stage": "awareness"|"comparison"|"decision", "shape": string }.',
  'Criteria:',
  '1. Commercial intent — the asker is in a buying or evaluation mindset.',
  '2. Realistic — phrased the way a real buyer would type it into ChatGPT.',
  "3. Category-level (not brand-level) — most prompts should NOT name the user's brand. Point: see if the brand gets cited unprompted.",
  '4. Varied prompt shapes: "best X for Y", "X vs Y", "alternatives to X", "what\'s the [cheapest/easiest/best] X", "X for [use case]".',
  '5. No vague queries like "what is X" or "how does X work".',
  '6. Mix awareness / comparison / decision stages.',
].join('\n');

const STRICT_SUFFIX =
  '\nReturn ONLY a JSON array. No prose. No code fences.';

function buildUserPrompt(brand: Brand, count: number): string {
  const competitors =
    brand.competitors.length > 0
      ? brand.competitors.join(', ')
      : '(none specified)';
  return [
    `Brand name: ${brand.name}`,
    `Brand domain: ${brand.domain}`,
    `Category: ${brand.category ?? '(unspecified)'}`,
    `Known competitors: ${competitors}`,
    '',
    `Generate exactly ${count} commercial-intent prompts for this category.`,
  ].join('\n');
}

function extractJsonArrayText(text: string): string {
  // Claude often wraps JSON in markdown fences despite "no fences"
  // instructions. Strip them defensively before scanning for [ / ].
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/, '');

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON array found in generator response');
  }
  return cleaned.slice(start, end + 1);
}

const VALID_STAGES = new Set(['awareness', 'comparison', 'decision']);

function validateAndShape(raw: unknown): NewPromptInput[] {
  if (!Array.isArray(raw)) {
    throw new Error('Generator returned non-array');
  }
  const out: NewPromptInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const text = obj.prompt;
    const intent_stage = obj.intent_stage;
    const shape = obj.shape;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    const normalizedStage =
      typeof intent_stage === 'string' && VALID_STAGES.has(intent_stage)
        ? intent_stage
        : null;
    const normalizedShape =
      typeof shape === 'string' && shape.trim().length > 0 ? shape : null;
    out.push({
      text: text.trim(),
      intent_stage: normalizedStage,
      shape: normalizedShape,
    });
  }
  if (out.length === 0) {
    throw new Error('Generator returned no valid prompt items');
  }
  return out;
}

async function callGenerator(
  env: PromptGenEnv,
  brand: Brand,
  count: number,
  strict: boolean,
): Promise<NewPromptInput[]> {
  const systemPrompt = strict
    ? BASE_SYSTEM_PROMPT + STRICT_SUFFIX
    : BASE_SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(brand, count);
  const responseText = await anthropicChat(
    requireAnthropicKey(env),
    userPrompt,
    systemPrompt,
    4000,
  );
  const jsonText = extractJsonArrayText(responseText);
  const parsed = JSON.parse(jsonText);
  return validateAndShape(parsed);
}

export async function generatePrompts(
  env: PromptGenEnv,
  brand: Brand,
  count = 20,
): Promise<NewPromptInput[]> {
  let prompts: NewPromptInput[];
  try {
    prompts = await callGenerator(env, brand, count, false);
  } catch (firstErr) {
    console.warn('generatePrompts: first attempt failed, retrying strict', {
      brand_id: brand.id,
      message: (firstErr as Error).message,
    });
    prompts = await callGenerator(env, brand, count, true);
  }
  await env.db.replacePrompts(brand.id, prompts);
  return prompts;
}
