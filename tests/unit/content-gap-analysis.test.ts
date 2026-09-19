import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFallbackRecommendations } from '../../src/core/content-gap-analysis.ts';

test('fallback recommendations stay grounded in observed losing prompts', () => {
  const recommendations = buildFallbackRecommendations(
    [
      {
        prompt_text: 'Acme vs Asana for agencies',
        engines_lost_on: ['claude', 'chatgpt'],
        competitors_winning: ['asana.com', 'monday.com'],
      },
      {
        prompt_text: 'Acme pricing for small teams',
        engines_lost_on: ['perplexity'],
        competitors_winning: ['asana.com'],
      },
    ],
    2,
  );

  assert.equal(recommendations.length, 2);
  assert.equal(recommendations[0].priority, 1);
  assert.equal(recommendations[0].suggested_format, 'comparison_page');
  assert.match(recommendations[0].topic, /Acme vs Asana for agencies/);
  assert.match(recommendations[0].rationale, /chatgpt, claude/);
  assert.match(recommendations[0].rationale, /asana\.com, monday\.com/);

  assert.equal(recommendations[1].priority, 2);
  assert.equal(recommendations[1].suggested_format, 'pricing_page');
  assert.match(recommendations[1].rationale, /Acme pricing for small teams/);
  assert.match(recommendations[1].rationale, /perplexity/);
});

test('fallback recommendations rank stronger observed losses first and respect the limit', () => {
  const recommendations = buildFallbackRecommendations(
    [
      {
        prompt_text: 'How to configure Acme',
        engines_lost_on: ['chatgpt'],
        competitors_winning: ['alpha.com'],
      },
      {
        prompt_text: 'Best workflow tools',
        engines_lost_on: ['chatgpt', 'claude'],
        competitors_winning: ['alpha.com', 'beta.com', 'gamma.com'],
      },
      {
        prompt_text: 'Does Acme support SSO?',
        engines_lost_on: ['gemini'],
        competitors_winning: ['beta.com'],
      },
    ],
    2,
  );

  assert.equal(recommendations.length, 2);
  assert.match(recommendations[0].topic, /Best workflow tools/);
  assert.equal(recommendations[0].suggested_format, 'listicle');
  assert.match(recommendations[1].topic, /Does Acme support SSO/);
  assert.equal(recommendations[1].suggested_format, 'faq_page');
});
