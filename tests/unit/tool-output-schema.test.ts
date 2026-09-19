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
    per_engine: [],
    top_winning_prompts: [
      { prompt: 'best project tools', engines_cited_in: ['chatgpt'] },
    ],
    top_losing_prompts: [
      { prompt: 'project tools for agencies', competitors_cited: ['beta.com'] },
    ],
  });
  assert.equal(valid.success, true);

  const invalid = schema.safeParse({
    brand: { id: 'acme', name: 'Acme', domain: 'acme.com', category: null },
    refreshed_at: '2026-09-19T00:00:00.000Z',
    overall_score: 50,
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
