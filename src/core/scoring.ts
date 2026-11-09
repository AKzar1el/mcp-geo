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
  // Backwards-compatible legacy field: this counts answer mentions, not links.
  engines_cited_in: string[];
  engines_mentioned_in: string[];
  engines_with_brand_link: string[];
}

export interface LosingPrompt {
  prompt: string;
  // Legacy historical answer-mention evidence; not a source-link guarantee.
  competitors_cited: string[];
  currently_tracked_competitors: string[];
  not_currently_tracked_competitors: string[];
}

export interface ScoreResult {
  overall_score: number;
  per_engine: PerEngineScore[];
  top_winning_prompts: WinningPrompt[];
  top_losing_prompts: LosingPrompt[];
}

export function computeOverallScore(
  brand: Brand,
  responses: PromptResponse[],
): ScoreResult {
  // A run may retain repeated successful observations of the same prompt.
  // Citation evidence keeps every row, but visibility scores count prompts,
  // not response attempts. Select one deterministic latest observation per
  // engine/prompt so retries cannot inflate coverage or bias the hit rate.
  const latestByEnginePrompt = new Map<string, PromptResponse>();
  for (const row of responses) {
    if (row.status !== 'ok') continue;
    const key = JSON.stringify([row.engine, row.prompt_id]);
    const previous = latestByEnginePrompt.get(key);
    if (!previous ||
        row.captured_at > previous.captured_at ||
        (row.captured_at === previous.captured_at && row.id > previous.id)) {
      latestByEnginePrompt.set(key, row);
    }
  }
  const okResponses = [...latestByEnginePrompt.values()];
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

  // Winning prompts rank by answer mentions; linked evidence is tracked
  // separately so legacy "cited" labels cannot imply an actual source URL.
  const winsByPrompt = new Map<
    string,
    { promptId: string; prompt: string; engines: Set<string>; linkedEngines: Set<string> }
  >();
  for (const r of okResponses) {
    if (r.brand_mentioned !== 1) continue;
    const existing = winsByPrompt.get(r.prompt_id);
    if (existing) {
      existing.engines.add(r.engine);
      if (r.brand_cited_with_link === 1) existing.linkedEngines.add(r.engine);
    } else {
      winsByPrompt.set(r.prompt_id, {
        promptId: r.prompt_id,
        prompt: r.prompt_text,
        engines: new Set([r.engine]),
        linkedEngines: new Set(r.brand_cited_with_link === 1 ? [r.engine] : []),
      });
    }
  }
  const top_winning_prompts: WinningPrompt[] = [...winsByPrompt.values()]
    .sort((a, b) => b.engines.size - a.engines.size ||
      a.prompt.localeCompare(b.prompt) || a.promptId.localeCompare(b.promptId))
    .slice(0, 3)
    .map((w) => {
      const mentionedIn = [...w.engines].sort();
      return {
        prompt: w.prompt,
        engines_cited_in: [...mentionedIn],
        engines_mentioned_in: mentionedIn,
        engines_with_brand_link: [...w.linkedEngines].sort(),
      };
    });

  // Losing prompts: per (prompt, engine), brand_mentioned=0 AND at least
  // one competitor present. Aggregate competitors across engines for the
  // same prompt — a competitor cited by multiple engines for the same
  // losing prompt only counts once. A prompt where the brand wins on one
  // engine but loses on another still appears here for the losing engine
  // (and may also appear in top_winning_prompts), which is informative.
  const lossByPrompt = new Map<
    string,
    { promptId: string; prompt: string; competitors: Set<string> }
  >();
  for (const r of okResponses) {
    if (r.brand_mentioned !== 0) continue;
    if (r.competitors_mentioned.length === 0) continue;
    const existing = lossByPrompt.get(r.prompt_id);
    if (existing) {
      for (const c of r.competitors_mentioned) existing.competitors.add(c);
    } else {
      lossByPrompt.set(r.prompt_id, {
        promptId: r.prompt_id,
        prompt: r.prompt_text,
        competitors: new Set(r.competitors_mentioned),
      });
    }
  }
  const currentlyTracked = new Set(brand.competitors);
  const losing: LosingPrompt[] = [...lossByPrompt.values()]
    .sort((a, b) => b.competitors.size - a.competitors.size ||
      a.prompt.localeCompare(b.prompt) || a.promptId.localeCompare(b.promptId))
    .map((l) => {
      const historical = [...l.competitors].sort();
      return {
        prompt: l.prompt,
        competitors_cited: historical,
        currently_tracked_competitors: historical.filter((c) => currentlyTracked.has(c)),
        not_currently_tracked_competitors: historical.filter((c) => !currentlyTracked.has(c)),
      };
    });
  const top_losing_prompts = losing.slice(0, 3);

  return {
    overall_score,
    per_engine,
    top_winning_prompts,
    top_losing_prompts,
  };
}
