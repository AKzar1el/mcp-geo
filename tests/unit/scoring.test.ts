// Unit tests for the score aggregation logic. Pure functions, no I/O.
//
// Run with:
//   npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOverallScore } from '../../src/scoring';
import type { Brand, PromptResponse, ResponseStatus } from '../../src/db';

const brand: Brand = {
  id: 'acme',
  user_id: 'dev-user',
  domain: 'acme.com',
  name: 'Acme',
  category: null,
  competitors: ['asana.com'],
  refresh_frequency: 'weekly',
  created_at: 0,
  updated_at: 0,
};

let nextId = 0;
function response(
  engine: string,
  promptId: string,
  brandMentioned: 0 | 1,
  opts: {
    status?: ResponseStatus;
    competitors?: string[];
  } = {},
): PromptResponse {
  nextId += 1;
  return {
    id: `r${nextId}`,
    run_id: 'run-1',
    prompt_id: promptId,
    prompt_text: `prompt text for ${promptId}`,
    engine,
    raw_response: 'response body',
    brand_mentioned: brandMentioned,
    brand_cited_with_link: 0,
    cited_urls: [],
    competitors_mentioned: opts.competitors ?? [],
    engine_citations: [],
    status: opts.status ?? 'ok',
    error_message: null,
    captured_at: 0,
  };
}

test('per-engine score is the hit rate over that engine total', () => {
  const result = computeOverallScore(brand, [
    response('chatgpt', 'p1', 1),
    response('chatgpt', 'p2', 0),
    response('chatgpt', 'p3', 0),
    response('chatgpt', 'p4', 1),
  ]);
  assert.equal(result.per_engine.length, 1);
  assert.equal(result.per_engine[0].engine, 'chatgpt');
  assert.equal(result.per_engine[0].score, 50);
  assert.equal(result.per_engine[0].prompts_appeared_in, 2);
  assert.equal(result.per_engine[0].total_prompts, 4);
});

test('overall score is the mean of per-engine scores', () => {
  const result = computeOverallScore(brand, [
    response('chatgpt', 'p1', 1), // chatgpt: 100
    response('gemini', 'p1', 0), // gemini: 0
  ]);
  assert.equal(result.overall_score, 50);
});

test('failed and skipped rows are excluded from scoring', () => {
  const result = computeOverallScore(brand, [
    response('chatgpt', 'p1', 1),
    response('chatgpt', 'p2', 0, { status: 'failed' }),
    response('chatgpt', 'p3', 0, { status: 'skipped' }),
  ]);
  assert.equal(result.per_engine[0].total_prompts, 1);
  assert.equal(result.per_engine[0].score, 100);
});

test('empty input yields zero overall score and no engines', () => {
  const result = computeOverallScore(brand, []);
  assert.equal(result.overall_score, 0);
  assert.deepEqual(result.per_engine, []);
  assert.deepEqual(result.top_winning_prompts, []);
  assert.deepEqual(result.top_losing_prompts, []);
});

test('winning prompts rank by number of engines citing the brand', () => {
  const result = computeOverallScore(brand, [
    response('chatgpt', 'p1', 1),
    response('gemini', 'p1', 1),
    response('claude', 'p1', 1),
    response('chatgpt', 'p2', 1),
  ]);
  assert.equal(result.top_winning_prompts[0].prompt, 'prompt text for p1');
  assert.deepEqual(result.top_winning_prompts[0].engines_cited_in, [
    'chatgpt',
    'claude',
    'gemini',
  ]);
  assert.equal(result.top_winning_prompts[1].prompt, 'prompt text for p2');
});

test('losing prompts require a competitor mention and aggregate across engines', () => {
  const result = computeOverallScore(brand, [
    // p1: lost on two engines, two distinct competitors
    response('chatgpt', 'p1', 0, { competitors: ['asana.com'] }),
    response('gemini', 'p1', 0, { competitors: ['monday.com'] }),
    // p2: brand absent but no competitor either — not a "loss"
    response('chatgpt', 'p2', 0),
  ]);
  assert.equal(result.top_losing_prompts.length, 1);
  assert.equal(result.top_losing_prompts[0].prompt, 'prompt text for p1');
  assert.deepEqual(result.top_losing_prompts[0].competitors_cited, [
    'asana.com',
    'monday.com',
  ]);
});
