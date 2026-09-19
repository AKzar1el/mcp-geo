// Day 5: Claude-Haiku-synthesized content gap recommendations.
// Same flow as src/prompt-generation.ts (call Haiku, parse JSON, retry
// once with a stricter suffix, validate shape, throw on second failure).
// The caller (get_content_gaps tool) falls back to deterministic,
// evidence-grounded recommendations if this function throws.

import { chatCompletion as anthropicChat } from './anthropic.js';
import type { Brand } from '../db/types.js';

export interface AnalysisEnv {
  ANTHROPIC_API_KEY?: string;
}

function requireAnthropicKey(env: AnalysisEnv): string {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  return env.ANTHROPIC_API_KEY;
}

export interface LosingPromptSummary {
  prompt_text: string;
  engines_lost_on: string[];
  competitors_winning: string[];
}

export interface ContentGapRecommendation {
  priority: 1 | 2 | 3 | 4 | 5;
  topic: string;
  rationale: string;
  suggested_format: string;
}

const VALID_FORMATS = new Set([
  'comparison_page',
  'listicle',
  'how_to_guide',
  'faq_page',
  'case_study',
  'pricing_page',
  'integration_landing_page',
]);

const BASE_SYSTEM_PROMPT = [
  'You are a senior SEO/content strategist analyzing why a brand is losing in AI search results.',
  'Given a list of buyer-intent prompts where the brand is NOT cited but its competitors ARE,',
  'produce a prioritized list of content recommendations.',
  '',
  'Return a JSON array only — no prose, no markdown fences.',
  'Each item: {',
  '  "priority": 1|2|3|4|5,',
  '  "topic": string,',
  '  "rationale": string,',
  '  "suggested_format": string',
  '}.',
  '',
  'Criteria:',
  "1. Topic should be specific and actionable (e.g., 'Comparison page: Brand vs Competitor A' not 'Write more content').",
  '2. Rationale should reference SPECIFIC losing prompts and SPECIFIC competitors winning them.',
  "3. suggested_format: one of: 'comparison_page', 'listicle', 'how_to_guide', 'faq_page', 'case_study', 'pricing_page', 'integration_landing_page'.",
  '4. Prioritize by impact: prompts where ALL competitors win get higher priority than prompts where only 1 wins.',
  '5. Mix tactical (quick wins) with strategic (longer plays).',
].join('\n');

const STRICT_SUFFIX =
  '\nReturn ONLY a JSON array. No prose. No code fences.';

function inferFallbackFormat(promptText: string): string {
  const prompt = promptText.toLowerCase();
  if (/\b(vs\.?|versus|compare|comparison|alternative|alternatives)\b/.test(prompt)) {
    return 'comparison_page';
  }
  if (/\b(price|pricing|cost|free|cheap|cheapest|affordable)\b/.test(prompt)) {
    return 'pricing_page';
  }
  if (/\b(integrate|integration|connect|connector|works with)\b/.test(prompt)) {
    return 'integration_landing_page';
  }
  if (/\b(how|guide|tutorial|setup|set up|configure)\b/.test(prompt)) {
    return 'how_to_guide';
  }
  if (/\b(best|top|tools|software|platforms|products)\b/.test(prompt)) {
    return 'listicle';
  }
  return 'faq_page';
}

function formatLabel(format: string): string {
  return format.replaceAll('_', ' ');
}

// Provider-free fallback used when the analyzer is unavailable. It must stay
// grounded in the same observed losing prompts that the model-backed path uses;
// otherwise a missing Anthropic key would silently degrade into generic GEO tips.
export function buildFallbackRecommendations(
  losingPrompts: LosingPromptSummary[],
  maxRecommendations: number,
): ContentGapRecommendation[] {
  return [...losingPrompts]
    .sort(
      (a, b) =>
        b.competitors_winning.length - a.competitors_winning.length ||
        b.engines_lost_on.length - a.engines_lost_on.length ||
        a.prompt_text.localeCompare(b.prompt_text),
    )
    .slice(0, maxRecommendations)
    .map((losingPrompt, index) => {
      const prompt = losingPrompt.prompt_text.trim();
      const competitors = [...new Set(losingPrompt.competitors_winning)].slice(0, 5);
      const engines = [...new Set(losingPrompt.engines_lost_on)].sort();
      const suggestedFormat = inferFallbackFormat(prompt);
      const competitorEvidence =
        competitors.length > 0
          ? competitors.join(', ')
          : 'at least one observed competitor';
      const engineEvidence =
        engines.length > 0 ? engines.join(', ') : 'the observed AI results';

      return {
        priority: Math.min(index + 1, 5) as 1 | 2 | 3 | 4 | 5,
        topic: `Address losing prompt: "${prompt}"`,
        rationale:
          `The brand is absent for "${prompt}" on ${engineEvidence} while ${competitorEvidence} are mentioned. ` +
          `Create a ${formatLabel(suggestedFormat)} that answers this exact buyer intent with specific, verifiable differentiation.`,
        suggested_format: suggestedFormat,
      };
    });
}

function buildUserPrompt(
  brand: Brand,
  losingPrompts: LosingPromptSummary[],
  maxRecommendations: number,
): string {
  // Top-5 competitors across the losing-prompt set, by mention count.
  const competitorCounts = new Map<string, number>();
  for (const lp of losingPrompts) {
    for (const c of lp.competitors_winning) {
      competitorCounts.set(c, (competitorCounts.get(c) ?? 0) + 1);
    }
  }
  const topCompetitors = [...competitorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([c]) => c);

  const lines = [
    `Brand: ${brand.name} (${brand.domain})`,
    `Category: ${brand.category ?? '(unspecified)'}`,
    `Top competitors winning where brand loses: ${topCompetitors.length > 0 ? topCompetitors.join(', ') : '(none)'}`,
    '',
    'Losing prompts and their winning competitors:',
  ];
  for (const lp of losingPrompts) {
    const engines = lp.engines_lost_on.join(', ');
    const competitors =
      lp.competitors_winning.length > 0
        ? lp.competitors_winning.join(', ')
        : '(unknown)';
    lines.push(`- "${lp.prompt_text}" — losing in ${engines}, competitors cited: ${competitors}`);
  }
  lines.push('');
  lines.push(
    `Generate exactly ${maxRecommendations} prioritized content recommendations.`,
  );
  return lines.join('\n');
}

function extractJsonArrayText(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON array found in content-gap response');
  }
  return cleaned.slice(start, end + 1);
}

function validateAndShape(raw: unknown): ContentGapRecommendation[] {
  if (!Array.isArray(raw)) {
    throw new Error('Content-gap response is not an array');
  }
  const out: ContentGapRecommendation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const priorityNum = Number(obj.priority);
    const topic = obj.topic;
    const rationale = obj.rationale;
    const format = obj.suggested_format;
    if (
      !Number.isInteger(priorityNum) ||
      priorityNum < 1 ||
      priorityNum > 5
    )
      continue;
    if (typeof topic !== 'string' || topic.trim().length === 0) continue;
    if (typeof rationale !== 'string' || rationale.trim().length === 0)
      continue;
    if (typeof format !== 'string' || !VALID_FORMATS.has(format)) continue;
    out.push({
      priority: priorityNum as 1 | 2 | 3 | 4 | 5,
      topic: topic.trim(),
      rationale: rationale.trim(),
      suggested_format: format,
    });
  }
  if (out.length === 0) {
    throw new Error('No valid recommendations in content-gap response');
  }
  return out;
}

async function callAnalyzer(
  env: AnalysisEnv,
  brand: Brand,
  losingPrompts: LosingPromptSummary[],
  maxRecommendations: number,
  strict: boolean,
): Promise<ContentGapRecommendation[]> {
  const systemPrompt = strict
    ? BASE_SYSTEM_PROMPT + STRICT_SUFFIX
    : BASE_SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(brand, losingPrompts, maxRecommendations);
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

export async function analyzeContentGaps(
  env: AnalysisEnv,
  brand: Brand,
  losingPrompts: LosingPromptSummary[],
  maxRecommendations: number,
): Promise<ContentGapRecommendation[]> {
  let recs: ContentGapRecommendation[];
  try {
    recs = await callAnalyzer(
      env,
      brand,
      losingPrompts,
      maxRecommendations,
      false,
    );
  } catch (firstErr) {
    console.warn('analyzeContentGaps: first attempt failed, retrying strict', {
      brand_id: brand.id,
      message: (firstErr as Error).message,
    });
    recs = await callAnalyzer(
      env,
      brand,
      losingPrompts,
      maxRecommendations,
      true,
    );
  }
  // Sort by priority asc and trim to requested count.
  recs.sort((a, b) => a.priority - b.priority);
  return recs.slice(0, maxRecommendations);
}
