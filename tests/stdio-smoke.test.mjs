// Smoke test for the local stdio CLI (dist/cli.js).
//
// Spawns the BUILT artifact with a fake engine key, drives a real
// JSON-RPC handshake over stdin/stdout, and asserts:
//   1. initialize succeeds,
//   2. tools/list returns all nine tools (six shared + three local
//      management tools),
//   3. nothing non-JSON ever appears on stdout (stdout is the JSON-RPC
//      channel; all logging must go to stderr).
//
// Requires `npm run build` first. Run with: npm run test:stdio
// Set STDIO_CLI_PATH to smoke-test a packed/installed artifact instead
// of the local dist/ build (used by the npm-pack gate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH =
  process.env.STDIO_CLI_PATH || resolve(__dirname, '..', 'dist', 'cli.js');

const EXPECTED_TOOLS = [
  'check_visibility',
  'get_visibility_history',
  'compare_competitors',
  'get_citations',
  'get_content_gaps',
  'refresh_brand',
  // Local management tools — CLI only, not present on the Worker.
  'track_brand',
  'list_brands',
  'generate_prompts',
];

function rpc(child, body) {
  child.stdin.write(JSON.stringify(body) + '\n');
}

test('stdio CLI: initialize + tools/list returns all nine tools, track_brand→list_brands works offline, stdout stays pure JSON', async () => {
  assert.ok(
    existsSync(CLI_PATH),
    `CLI artifact not found at ${CLI_PATH} — run \`npm run build\` first`,
  );

  const tmp = mkdtempSync(join(tmpdir(), 'digestseo-stdio-smoke-'));
  const child = spawn(process.execPath, [CLI_PATH], {
    env: {
      ...process.env,
      // Fake key: availability checks only test key PRESENCE; no engine
      // call happens during initialize/tools/list.
      OPENAI_API_KEY: 'sk-fake-smoke-test-key',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      PERPLEXITY_API_KEY: '',
      SERPAPI_API_KEY: '',
      // Never touch the developer's real ~/.digestseo database.
      DIGESTSEO_DB_PATH: join(tmp, 'smoke.sqlite'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutLines = [];
  const responsesById = new Map();
  let stdoutBuffer = '';
  let stderrText = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, nl).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      stdoutLines.push(line);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responsesById.set(msg.id, msg);
      } catch {
        // leave the non-JSON line in stdoutLines; asserted below
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8');
  });

  const waitFor = (id, timeoutMs = 15_000) =>
    new Promise((resolvePromise, rejectPromise) => {
      const startedAt = Date.now();
      const tick = () => {
        if (responsesById.has(id)) return resolvePromise(responsesById.get(id));
        if (Date.now() - startedAt > timeoutMs) {
          return rejectPromise(
            new Error(
              `timed out waiting for JSON-RPC response id=${id}; stderr so far:\n${stderrText}`,
            ),
          );
        }
        setTimeout(tick, 25);
      };
      tick();
    });

  try {
    rpc(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'digestseo-stdio-smoke', version: '1.0.0' },
      },
    });
    const init = await waitFor(1);
    assert.ok(!init.error, `initialize errored: ${JSON.stringify(init.error)}`);
    assert.equal(init.result?.serverInfo?.name, 'digestseo-mcp');

    rpc(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await waitFor(2);
    assert.ok(!list.error, `tools/list errored: ${JSON.stringify(list.error)}`);
    const names = new Set((list.result?.tools ?? []).map((t) => t.name));
    for (const tool of EXPECTED_TOOLS) {
      assert.ok(
        names.has(tool),
        `tools/list missing '${tool}' (got: ${[...names].sort().join(', ')})`,
      );
    }
    assert.equal(
      names.size,
      EXPECTED_TOOLS.length,
      `expected exactly ${EXPECTED_TOOLS.length} tools, got ${names.size}`,
    );

    // End-to-end seeding flow, fully offline: with no ANTHROPIC_API_KEY
    // the generator falls back to the three starter prompts, so
    // track_brand never touches the network.
    rpc(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'track_brand',
        arguments: {
          brand_id: 'smoke-brand',
          name: 'Smoke Test Brand',
          domain: 'https://www.Smoke-Test.example/pricing',
          category: 'Smoke testing software',
          competitors: ['rival.example'],
        },
      },
    });
    const tracked = await waitFor(3);
    assert.ok(
      !tracked.error,
      `track_brand errored: ${JSON.stringify(tracked.error)}`,
    );
    assert.ok(
      !tracked.result?.isError,
      `track_brand returned isError: ${JSON.stringify(tracked.result)}`,
    );
    const trackPayload = JSON.parse(tracked.result.content[0].text);
    assert.equal(trackPayload.seeded, true);
    assert.equal(trackPayload.brand_id, 'smoke-brand');
    assert.equal(trackPayload.prompt_source, 'fallback');
    assert.equal(trackPayload.prompts_inserted, 3);
    assert.equal(
      trackPayload.domain,
      'smoke-test.example',
      'domain was not normalized (scheme/www/path stripping)',
    );

    rpc(child, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_brands', arguments: {} },
    });
    const listed = await waitFor(4);
    assert.ok(
      !listed.error && !listed.result?.isError,
      `list_brands failed: ${JSON.stringify(listed.error ?? listed.result)}`,
    );
    const listPayload = JSON.parse(listed.result.content[0].text);
    const smoke = (listPayload.brands ?? []).find(
      (b) => b.brand_id === 'smoke-brand',
    );
    assert.ok(smoke, 'tracked brand missing from list_brands');
    assert.equal(Number(smoke.active_prompts), 3);
    assert.deepEqual(smoke.competitors, ['rival.example']);

    // stdout purity: every line the process ever wrote must be JSON.
    for (const line of stdoutLines) {
      assert.doesNotThrow(
        () => JSON.parse(line),
        `non-JSON output on stdout: ${JSON.stringify(line)}`,
      );
    }
  } finally {
    child.kill();
    await new Promise((r) => child.once('close', r));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('stdio CLI: zero engine keys prints a friendly error and exits 1', async () => {
  assert.ok(existsSync(CLI_PATH), `CLI artifact not found at ${CLI_PATH}`);
  const tmp = mkdtempSync(join(tmpdir(), 'digestseo-stdio-nokeys-'));
  const child = spawn(process.execPath, [CLI_PATH], {
    env: {
      ...process.env,
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      PERPLEXITY_API_KEY: '',
      SERPAPI_API_KEY: '',
      DIGESTSEO_DB_PATH: join(tmp, 'smoke.sqlite'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrText = '';
  let stdoutText = '';
  child.stderr.on('data', (c) => (stderrText += c.toString('utf8')));
  child.stdout.on('data', (c) => (stdoutText += c.toString('utf8')));
  const exitCode = await new Promise((r) => child.once('close', r));
  rmSync(tmp, { recursive: true, force: true });

  assert.equal(exitCode, 1);
  assert.equal(stdoutText, '', 'error message leaked onto stdout');
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'PERPLEXITY_API_KEY',
    'SERPAPI_API_KEY',
  ]) {
    assert.ok(
      stderrText.includes(key),
      `friendly error does not mention ${key}; stderr was:\n${stderrText}`,
    );
  }
});
