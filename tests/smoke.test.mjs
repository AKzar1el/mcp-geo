// Smoke tests for the deployed digestseo-mcp Worker.
//
// Runs structural checks against a live deployment. Uses only Node's
// built-in test runner and global fetch — no npm dependencies, no jq,
// no bash. Works on Windows, macOS, Linux.
//
// Run with:
//   npm run test:smoke
//
// Configuration (set in shell or in tests/../.env.test):
//   GEO_BASE_URL      base URL of the deployed Worker, no trailing slash.
//                     Defaults to http://localhost:8787 so `wrangler dev`
//                     works out of the box.
//   MCP_ACCESS_TOKEN  optional. Required for tools/list and tools/call
//                     checks. Without it those checks are skipped.
//   SEED_SECRET       optional. Required for the admin/seed +
//                     admin/run-live + D1-backed check_visibility checks.
//   SEED_BRAND_ID     optional. The brand id to seed and check (defaults
//                     to "smoke-test"). Must match the brand_id in your
//                     seed payload (see SEED_BRAND_JSON below).
//   SEED_BRAND_JSON   optional. JSON payload sent to /admin/seed. Use
//                     this to fully customize the brand identity for the
//                     test. Defaults to an Acme example.
//
// See tests/README.md (in the original geo-mcp repo) for the rationale
// behind structural-only assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const envFile = resolve(projectRoot, '.env.test');

if (existsSync(envFile)) {
  const content = readFileSync(envFile, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const GEO_BASE_URL = (
  process.env.GEO_BASE_URL || 'http://localhost:8787'
).replace(/\/$/, '');
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN || '';
const SEED_SECRET = process.env.SEED_SECRET || '';
const SEED_BRAND_ID = process.env.SEED_BRAND_ID || 'smoke-test';
const SEED_BRAND_JSON = process.env.SEED_BRAND_JSON
  ? JSON.parse(process.env.SEED_BRAND_JSON)
  : {
      brand_id: SEED_BRAND_ID,
      name: 'Acme Project Tool',
      domain: 'acme.com',
      category: 'Project management software',
      competitors: ['asana.com', 'monday.com', 'clickup.com', 'notion.so'],
    };

const tokenSkipReason = MCP_ACCESS_TOKEN
  ? false
  : 'MCP_ACCESS_TOKEN not set; skipping authenticated checks';
const adminSkipReason = SEED_SECRET
  ? false
  : 'SEED_SECRET not set; skipping admin + D1 checks';
const fullSkipReason =
  MCP_ACCESS_TOKEN && SEED_SECRET
    ? false
    : 'requires both MCP_ACCESS_TOKEN and SEED_SECRET';

let seededRunIds = /** @type {Record<string, string>} */ ({});
let seededPromptsTotal = 0;

async function mcpInitSession() {
  const resp = await fetch(`${GEO_BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MCP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'digestseo-mcp-smoke', version: '1.0.0' },
      },
    }),
  });
  return resp.headers.get('mcp-session-id') || '';
}

async function mcpCall(sessionId, body) {
  const resp = await fetch(`${GEO_BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MCP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream') || text.includes('\ndata: ') || text.startsWith('data: ')) {
    const dataLines = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    return JSON.parse(dataLines.join(''));
  }
  return JSON.parse(text);
}

async function adminPost(path, body) {
  return await fetch(`${GEO_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'X-Seed-Secret': SEED_SECRET,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('CHECK 1: GET / returns 200 and identifies the MCP server', async () => {
  const resp = await fetch(`${GEO_BASE_URL}/`);
  assert.equal(resp.status, 200);
  const body = await resp.text();
  assert.ok(
    body.includes('digestseo-mcp') || body.includes('MCP'),
    `body did not identify the MCP server: ${body.slice(0, 200)}`,
  );
});

test('CHECK 2: GET /healthz returns 200 with body "ok"', async () => {
  const resp = await fetch(`${GEO_BASE_URL}/healthz`);
  assert.equal(resp.status, 200);
  const body = await resp.text();
  assert.equal(body, 'ok');
});

test('CHECK 3: GET /authorize without params is 4xx (not 200, not 500)', async () => {
  const resp = await fetch(`${GEO_BASE_URL}/authorize`);
  assert.ok(
    resp.status >= 400 && resp.status < 500,
    `expected 4xx, got ${resp.status}`,
  );
});

test('CHECK 4: POST /mcp without auth returns 401', async () => {
  const resp = await fetch(`${GEO_BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'unauth', version: '1' },
      },
    }),
  });
  assert.equal(resp.status, 401);
});

test(
  'CHECK 5: tools/list contains all 6 expected tool names',
  { skip: tokenSkipReason },
  async () => {
    const session = await mcpInitSession();
    assert.ok(session, 'no Mcp-Session-Id returned from initialize');
    const env = await mcpCall(session, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    assert.ok(!env.error, `tools/list returned error: ${JSON.stringify(env.error)}`);
    const tools = env?.result?.tools ?? [];
    const names = new Set(tools.map((t) => t.name));
    const expected = [
      'check_visibility',
      'get_visibility_history',
      'compare_competitors',
      'get_citations',
      'get_content_gaps',
      'refresh_brand',
    ];
    for (const name of expected) {
      assert.ok(
        names.has(name),
        `tools/list missing tool '${name}' (got: ${[...names].sort().join(', ')})`,
      );
    }
  },
);

test(
  'CHECK 6: POST /admin/seed succeeds and returns the configured brand_id',
  { skip: adminSkipReason },
  async () => {
    const resp = await adminPost('/admin/seed', SEED_BRAND_JSON);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(typeof data.seeded, 'boolean');
    assert.equal(data.brand_id, SEED_BRAND_ID);
  },
);

test(
  'CHECK 7: POST /admin/run-live returns at least 1 run_id and prompts_total >= 1',
  { skip: adminSkipReason },
  async () => {
    const resp = await adminPost('/admin/run-live', { brand_id: SEED_BRAND_ID });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(
      data.run_ids && typeof data.run_ids === 'object',
      'run_ids missing or not an object',
    );
    const engineKeys = Object.keys(data.run_ids);
    assert.ok(
      engineKeys.length >= 1,
      `expected at least 1 engine run_id, got ${engineKeys.length}`,
    );
    for (const engine of engineKeys) {
      assert.equal(
        typeof data.run_ids[engine],
        'string',
        `run_ids.${engine} should be a string, got ${data.run_ids[engine]}`,
      );
      assert.ok(
        data.run_ids[engine].length > 0,
        `run_ids.${engine} is empty`,
      );
    }
    assert.ok(
      Array.isArray(data.engines) && data.engines.length === engineKeys.length,
      `engines array (${data.engines?.length}) should match run_ids size (${engineKeys.length})`,
    );
    assert.equal(typeof data.prompts_total, 'number');
    assert.ok(
      data.prompts_total >= 1,
      `prompts_total should be positive, got ${data.prompts_total}`,
    );
    seededRunIds = data.run_ids;
    seededPromptsTotal = data.prompts_total;
  },
);

test(
  'CHECK 8: wait 90s for the parallel run(s) to complete',
  { skip: adminSkipReason },
  async () => {
    // Worst-case 5 engines × ~20 prompts × CONCURRENCY=5 ≈ 4 chunks × ~5s
    // per engine; SerpAPI is the slow ceiling. 90s margin covers cache
    // misses across all available engines.
    await new Promise((r) => setTimeout(r, 90_000));
  },
);

test(
  'CHECK 9: check_visibility returns D1-backed numbers within score bounds',
  { skip: fullSkipReason },
  async () => {
    const session = await mcpInitSession();
    assert.ok(session, 'no Mcp-Session-Id returned from initialize');
    const env = await mcpCall(session, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'check_visibility', arguments: { brand_id: SEED_BRAND_ID } },
    });
    assert.ok(
      !env.error,
      `check_visibility returned error: ${JSON.stringify(env.error)}`,
    );
    const text = env?.result?.content?.[0]?.text ?? '';
    assert.ok(text, 'check_visibility returned no content');
    const payload = JSON.parse(text);
    assert.equal(payload.brand?.id, SEED_BRAND_ID);
    assert.equal(typeof payload.overall_score, 'number');
    assert.ok(
      payload.overall_score >= 0 && payload.overall_score <= 100,
      `overall_score out of range: ${payload.overall_score}`,
    );
    assert.ok(
      Array.isArray(payload.per_engine) && payload.per_engine.length >= 1,
      `expected at least 1 per_engine entry, got ${payload.per_engine?.length}`,
    );
    const known = new Set([
      'chatgpt',
      'claude',
      'perplexity',
      'gemini',
      'ai_overviews',
    ]);
    for (const pe of payload.per_engine) {
      assert.ok(
        known.has(pe.engine),
        `unknown engine in per_engine: ${pe.engine}`,
      );
      assert.equal(typeof pe.total_prompts, 'number');
      assert.ok(
        pe.total_prompts >= 1,
        `per_engine[${pe.engine}].total_prompts should be positive: ${pe.total_prompts}`,
      );
    }
  },
);

test(
  'CHECK 10: POST /admin/generate-prompts inserts at least 1 prompt',
  { skip: adminSkipReason },
  async () => {
    const resp = await adminPost('/admin/generate-prompts', {
      brand_id: SEED_BRAND_ID,
    });
    // Without ANTHROPIC_API_KEY this returns 400 — that's a valid skip,
    // not a failure. Asserting status<500 covers both "success" and
    // "missing key" paths so the test surfaces real regressions only.
    assert.ok(
      resp.status < 500,
      `unexpected 5xx from /admin/generate-prompts: ${resp.status}`,
    );
    if (resp.status === 200) {
      const data = await resp.json();
      assert.equal(data.brand_id, SEED_BRAND_ID);
      assert.equal(data.prompt_source, 'generated');
      assert.equal(typeof data.prompts_inserted, 'number');
      assert.ok(
        data.prompts_inserted > 0,
        `prompts_inserted should be positive, got ${data.prompts_inserted}`,
      );
    }
  },
);

test(
  'CHECK 11: POST /admin/trigger-cron-test returns brands_due_count',
  { skip: adminSkipReason },
  async () => {
    const resp = await adminPost('/admin/trigger-cron-test');
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(typeof data.brands_due_count, 'number');
    assert.ok(
      data.brands_due_count >= 0,
      `brands_due_count must be non-negative, got ${data.brands_due_count}`,
    );
  },
);
