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
  requested_competitor: string | null;
  provider_source_count: number;
  provider_source_urls_truncated: boolean;
  provider_source_urls: Array<{ url: string; url_redacted: boolean }>;
  evidence_note: string;
};

type Handler = (args: {
  brand_id: string; run_id: string; response_id: string; focus_competitor?: string;
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

test('recorded competitor focus brings a distant mention into the redacted evidence excerpt', async () => {
  const handler = setup(run, [{ ...response,
    brand_mentioned: 0,
    raw_response: `${'Neutral background. '.repeat(25)}Asana supports teams. Authorization: Bearer DISTANT_SECRET`,
  }]);
  assert.ok(handler);
  const args = { brand_id: brand.id, run_id: run.id, response_id: response.id };
  const baseline = (await handler(args)).structuredContent;
  assert.doesNotMatch(baseline.response_excerpt, /Asana supports/);
  assert.equal(baseline.requested_competitor, null);
  const focused = (await handler({ ...args, focus_competitor: 'ASANA.COM' })).structuredContent;
  assert.equal(focused.requested_competitor, 'asana.com');
  assert.match(focused.response_excerpt, /Asana supports/);
  assert.doesNotMatch(focused.response_excerpt, /DISTANT_SECRET/);
  assert.ok(focused.response_excerpt.length <= 250);
  await assert.rejects(handler({ ...args, focus_competitor: 'untracked.example' }), /not found|not recorded/i);
});

test('observation evidence exposes bounded, credential-redacted provider-native source links only', async () => {
  const sourceUrls = [
    'https://sources.example.org/a?api_key=secret-a&topic=geo',
    'https://sources.example.org/b#access_token=secret-b',
    'https://user:pass@sources.example.org/private',
    'http://localhost/admin',
    'javascript:alert(1)',
    'https://sources.example.org/a?api_key=secret-a&topic=geo',
    'https://sources.example.org/c',
    'https://sources.example.org/d',
    'https://sources.example.org/e',
    'https://sources.example.org/f',
  ];
  const handler = setup(run, [{ ...response, engine_citations: sourceUrls }]);
  assert.ok(handler);
  const result = (await handler({ brand_id: brand.id, run_id: run.id, response_id: response.id })).structuredContent;
  assert.equal(result.provider_source_count, 6);
  assert.equal(result.provider_source_urls_truncated, true);
  assert.equal(result.provider_source_urls.length, 5);
  assert.deepEqual(result.provider_source_urls.slice(0, 2), [
    { url: 'https://sources.example.org/a?api_key=[REDACTED]&topic=geo', url_redacted: true },
    { url: 'https://sources.example.org/b#access_token=[REDACTED]', url_redacted: true },
  ]);
  assert.doesNotMatch(JSON.stringify(result.provider_source_urls), /secret-a|secret-b|user:pass|localhost|javascript:/);
  assert.match(result.evidence_note, /provider-returned.*not independently verified/i);
});

test('observation evidence masks OAuth fragment credentials before hash-route query separators', async () => {
  const handler = setup(run, [{ ...response, engine_citations: [
    'https://sources.example.org/page#access_token=SOURCE_SECRET?view=public',
    'https://sources.example.org/page#/viewer?token=OTHER_SECRET&view=public',
  ] }]);
  assert.ok(handler);
  const result = (await handler({ brand_id: brand.id, run_id: run.id, response_id: response.id })).structuredContent;
  assert.deepEqual(result.provider_source_urls, [
    { url: 'https://sources.example.org/page#access_token=[REDACTED]?view=public', url_redacted: true },
    { url: 'https://sources.example.org/page#/viewer?token=[REDACTED]&view=public', url_redacted: true },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /SOURCE_SECRET|OTHER_SECRET/);
});

test('observation evidence excludes special-use internal hosts from provider source links', async () => {
  const handler = setup(run, [{ ...response, engine_citations: [
    'https://team.portal.local/notes',
    'https://service.localhost/private',
    'https://staging.internal/dashboard',
    'https://fixture.test/example',
    'https://broken.invalid/example',
    'https://router.home.arpa/config',
    'https://home.arpa/router',
    'https://HOME.ARPA./config',
    'https://docs.example.org/public',
  ] }]);
  assert.ok(handler);
  const result = (await handler({ brand_id: brand.id, run_id: run.id, response_id: response.id })).structuredContent;
  assert.equal(result.provider_source_count, 1);
  assert.equal(result.provider_source_urls_truncated, false);
  assert.deepEqual(result.provider_source_urls, [
    { url: 'https://docs.example.org/public', url_redacted: false },
  ]);
});
