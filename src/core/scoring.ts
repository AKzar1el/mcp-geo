import type { Brand, PromptResponse } from '../db/types.js';

// Score formula (v1):
//   per_engine_score = round(100 * (prompts_with_brand_mentioned / total_prompts))
//   overall_score    = mean of per-engine scores
// Day 3 feeds responses from up to 4 engines through the same function —
// the grouping/averaging logic is identical, just with more data.
// We'll likely move to a weighted formula (linked > mention > paraphrase,
// awareness > comparison prompts, etc.) once we have enough data to tune it.

export interface PerEngineScore {
  engine: string;
  score: number;
  prompts_appeared_in: number;
  total_prompts: number;
}

export interface WinningPrompt {
  prompt: string;
  engines_cited_in: string[];
}

export interface LosingPrompt {
  prompt: string;
  competitors_cited: string[];
}

export interface ScoreResult {
  overall_score: number;
  per_engine: PerEngineScore[];
  top_winning_prompts: WinningPrompt[];
  top_losing_prompts: LosingPrompt[];
}

export function computeOverallScore(
  _brand: Brand,
  responses: PromptResponse[],
): ScoreResult {
  // Defense in depth: getResponsesForRun already filters status='ok',
  // but any future caller that bypasses that helper would otherwise
  // count failed/skipped rows as zero-mention hits and silently inflate
  // the denominator. Belt + suspenders.
  const okResponses = responses.filter((r) => r.status === 'ok');
  const byEngine = new Map<string, PromptResponse[]>();
  for (const r of okResponses) {
    const arr = byEngine.get(r.engine);
    if (arr) arr.push(r);
    else byEngine.set(r.engine, [r]);
  }

  const per_engine: PerEngineScore[] = [];
  for (const [engine, rows] of byEngine) {
    const total = rows.length;
    const hit = rows.filter((r) => r.brand_mentioned === 1).length;
    const score = total === 0 ? 0 : Math.round((100 * hit) / total);
    per_engine.push({
      engine,
      score,
      prompts_appeared_in: hit,
      total_prompts: total,
    });
  }
  per_engine.sort((a, b) => a.engine.localeCompare(b.engine));

  const overall_score =
    per_engine.length === 0
      ? 0
      : Math.round(
          per_engine.reduce((sum, e) => sum + e.score, 0) / per_engine.length,
        );

  // Winning prompts: brand_mentioned across the most engines. With one engine
  // today every winner has exactly one entry; the structure generalizes for
  // when claude/perplexity/gemini land in Days 3-4.
  const winsByPrompt = new Map<
    string,
    { prompt: string; engines: Set<string> }
  >();
  for (const r of okResponses) {
    if (r.brand_mentioned !== 1) continue;
    const existing = winsByPrompt.get(r.prompt_id);
    if (existing) existing.engines.add(r.engine);
    else
      winsByPrompt.set(r.prompt_id, {
        prompt: r.prompt_text,
        engines: new Set([r.engine]),
      });
  }
  const top_winning_prompts: WinningPrompt[] = [...winsByPrompt.values()]
    .sort((a, b) => b.engines.size - a.engines.size)
    .slice(0, 3)
    .map((w) => ({
      prompt: w.prompt,
      engines_cited_in: [...w.engines].sort(),
    }));

  // Losing prompts: per (prompt, engine), brand_mentioned=0 AND at least
  // one competitor present. Aggregate competitors across engines for the
  // same prompt — a competitor cited by multiple engines for the same
  // losing prompt only counts once. A prompt where the brand wins on one
  // engine but loses on another still appears here for the losing engine
  // (and may also appear in top_winning_prompts), which is informative.
  const lossByPrompt = new Map<
    string,
    { prompt: string; competitors: Set<string> }
  >();
  for (const r of okResponses) {
    if (r.brand_mentioned !== 0) continue;
    if (r.competitors_mentioned.length === 0) continue;
    const existing = lossByPrompt.get(r.prompt_id);
    if (existing) {
      for (const c of r.competitors_mentioned) existing.competitors.add(c);
    } else {
      lossByPrompt.set(r.prompt_id, {
        prompt: r.prompt_text,
        competitors: new Set(r.competitors_mentioned),
      });
    }
  }
  const losing: LosingPrompt[] = [...lossByPrompt.values()].map((l) => ({
    prompt: l.prompt,
    competitors_cited: [...l.competitors].sort(),
  }));
  losing.sort((a, b) => b.competitors_cited.length - a.competitors_cited.length);
  const top_losing_prompts = losing.slice(0, 3);

  return {
    overall_score,
    per_engine,
    top_winning_prompts,
    top_losing_prompts,
  };
}
