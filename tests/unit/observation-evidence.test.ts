import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type { Brand, Db, PromptResponse, Run } from '../../src/db/types.ts';

const brand: Brand = {
  id: 'acme', user_id: 'owner', domain: 'acme.com', name: 'Acme',
  category: null, competitors: ['asana.com'], aliases: [], exclude_terms: [],
  refresh_frequency: 'weekly', created_at: 0, updated_at: 0,
  identity_changed_at: Date.UTC(2026, 10, 20),
};

const run: Run = {
  id: 'run-1', brand_id: 'acme', engine: 'chatgpt', mode: 'live',
  status: 'completed', batch_id: null, prompts_total: 1, prompts_completed: 1,
  cost_eur_estimate: null, error: null, started_at: Date.UTC(2026, 10, 19),
  completed_at: Date.UTC(2026, 10, 21),
};

const response: PromptResponse = {
  id: 'response-1', run_id: run.id, prompt_id: 'old-prompt',
  prompt_text: 'Which tool helps teams manage projects?', engine: 'chatgpt',
  raw_response: 'Acme and Asana: https://example.com/path?access_token=secret-value&safe=yes Authorization: Bearer hidden-token',
  brand_mentioned: 1, brand_cited_with_link: 0, cited_urls: [],
  competitors_mentioned: ['asana.com'], engine_citations: [],
  status: 'ok', error_message: null, captured_at: Date.UTC(2026, 10, 19, 12),
};

type EvidenceResult = {
  brand_id: string;
  run_id: string;
  response_id: string;
  prompt: string;
  status: string;
  measurement_mode: string;
  identity_scope: string;
  active_prompt: boolean;
  response_excerpt: string;
  evidence_note: string;
};

type Handler = (args: {
  brand_id: string; run_id: string; response_id: string;
}) => Promise<{ structuredContent: EvidenceResult }>;

function setup(runRecord: Run = run, rows: PromptResponse[] = [response]): Handler | undefined {
  let handler: Handler | undefined;
  const server = {
    registerTool(name: string, _config: unknown, callback: unknown) {
      if (name === 'get_observation_evidence') handler = callback as Handler;
    },
  } as unknown as McpServer;
  registerTools(server, {
    db: {
      getBrand: async () => brand,
      getRunById: async () => runRecord,
      getResponsesForRun: async () => rows,
      getActivePrompts: async () => [],
    } as Db,
    env: {}, refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  return handler;
}

test('evidence reference resolves a scoped redacted excerpt without provider traffic', async () => {
  const handler = setup();
  assert.ok(handler, 'get_observation_evidence must be registered');
  const result = (await handler({ brand_id: 'acme', run_id: 'run-1', response_id: 'response-1' })).structuredContent;
  assert.equal(result.brand_id, 'acme');
  assert.equal(result.run_id, 'run-1');
  assert.equal(result.response_id, 'response-1');
  assert.equal(result.prompt, response.prompt_text);
  assert.equal(result.status, 'ok');
  assert.equal(result.measurement_mode, 'search_requested');
  assert.equal(result.identity_scope, 'historical_identity');
  assert.equal(result.active_prompt, false);
  assert.match(result.response_excerpt, /access_token=\[REDACTED\]/);
  assert.match(result.response_excerpt, /Authorization: Bearer \[REDACTED\]/);
  assert.doesNotMatch(result.response_excerpt, /secret-value|hidden-token/);
  assert.ok(result.response_excerpt.length <= 250);
  assert.match(result.evidence_note, /not a full answer or an independently verified/i);
});

test('evidence lookup cannot cross a brand, a run, or a successful response boundary', async () => {
  const foreign = setup({ ...run, brand_id: 'foreign-brand' });
  assert.ok(foreign);
  await assert.rejects(foreign({ brand_id: 'acme', run_id: run.id, response_id: response.id }), /not found/i);
  const wrongRun = setup(run, [{ ...response, run_id: 'other-run' }]);
  assert.ok(wrongRun);
  await assert.rejects(wrongRun({ brand_id: 'acme', run_id: run.id, response_id: response.id }), /not found/i);
  const failed = setup(run, [{ ...response, status: 'failed', raw_response: 'secret', error_message: 'credential' }]);
  assert.ok(failed);
  await assert.rejects(failed({ brand_id: 'acme', run_id: run.id, response_id: response.id }), /not found/i);
});
