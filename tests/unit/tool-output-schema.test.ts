import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodType } from 'zod';
import { registerTools } from '../../src/core/tools.ts';
import type { Db } from '../../src/db/types.ts';

type ToolConfig = {
  outputSchema?: ZodType;
};

function captureOutputSchemas(): Map<string, ZodType> {
  const schemas = new Map<string, ZodType>();
  const server = {
    registerTool(name: string, config: ToolConfig) {
      if (config.outputSchema) schemas.set(name, config.outputSchema);
    },
  } as unknown as McpServer;

  registerTools(server, {
    db: {} as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  return schemas;
}

test('visibility output schema describes winning and losing prompt records', () => {
  const schema = captureOutputSchemas().get('check_visibility');
  assert.ok(schema);

  const valid = schema.safeParse({
    brand: { id: 'acme', name: 'Acme', domain: 'acme.com', category: null },
    refreshed_at: '2026-09-19T00:00:00.000Z',
    overall_score: 50,
    missing_requested_engines: [],
    measurement_scope: {
      search_requested: { score: null, engines: [] },
      model_only: { score: 50, engines: ['claude'] },
      mixed_modes: false,
      note: 'Model-only results do not establish live search citations.',
    },
    google_search_sampling: null,
    freshness: {
      oldest_refreshed_at: '2026-09-18T00:00:00.000Z',
      newest_refreshed_at: '2026-09-19T00:00:00.000Z',
      age_spread_hours: 24,
      mixed_age_warning: true,
      older_engines: ['claude'],
    },
    prompt_set_comparability: {
      active_prompt_count: 2,
      engines_with_retired_prompt_evidence: ['claude'],
      historical_prompt_warning: true,
      note: 'The Claude snapshot uses retired prompts.',
    },
    configuration_comparability: {
      brand_updated_at: '2026-09-19T00:00:00.000Z',
      engines_scanned_before_update: ['claude'],
      historical_settings_warning: true,
      note: 'Brand settings may have changed since the scan.',
    },
    per_engine: [],
    top_winning_prompts: [
      {
        prompt: 'best project tools',
        engines_cited_in: ['chatgpt'],
        engines_mentioned_in: ['chatgpt'],
        engines_with_brand_link: [],
      },
    ],
    winning_prompt_evidence_note: 'Legacy cited field is mention-only.',
    top_losing_prompts: [
      { prompt: 'project tools for agencies', competitors_cited: ['beta.com'] },
    ],
  });
  assert.equal(valid.success, true);

  const invalid = schema.safeParse({
    brand: { id: 'acme', name: 'Acme', domain: 'acme.com', category: null },
    refreshed_at: '2026-09-19T00:00:00.000Z',
    overall_score: 50,
    measurement_scope: {
      search_requested: { score: null, engines: [] },
      model_only: { score: 50, engines: ['claude'] },
      mixed_modes: false,
      note: 'Model-only results do not establish live search citations.',
    },
    google_search_sampling: null,
    freshness: {
      oldest_refreshed_at: '2026-09-18T00:00:00.000Z',
      newest_refreshed_at: '2026-09-19T00:00:00.000Z',
      age_spread_hours: 24,
      mixed_age_warning: true,
      older_engines: ['claude'],
    },
    per_engine: [],
    top_winning_prompts: [{ prompt: 'missing engines' }],
    top_losing_prompts: [],
  });
  assert.equal(invalid.success, false);
});

test('content-gap output schema describes recommendation records', () => {
  const schema = captureOutputSchemas().get('get_content_gaps');
  assert.ok(schema);

  assert.equal(
    schema.safeParse({
      brand_id: 'acme',
      recommendations: [
        {
          priority: 1,
          topic: 'Acme vs Beta',
          rationale: 'Beta wins an observed buyer-intent prompt.',
          suggested_format: 'comparison_page',
        },
      ],
      prompt_source: 'fallback',
    }).success,
    true,
  );

  assert.equal(
    schema.safeParse({
      brand_id: 'acme',
      recommendations: [
        {
          priority: 6,
          topic: 'Invalid priority',
          rationale: 'Outside the supported recommendation contract.',
          suggested_format: 'comparison_page',
        },
      ],
      prompt_source: 'generated',
    }).success,
    false,
  );
});
