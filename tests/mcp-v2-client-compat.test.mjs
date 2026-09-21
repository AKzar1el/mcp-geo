import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const CLI_PATH = resolve('dist', 'cli.js');
const EXPECTED_TOOLS = ['check_visibility','compare_competitors','generate_prompts','get_citations','get_content_gaps','get_visibility_history','list_brands','list_prompts','refresh_brand','set_prompts','track_brand'];

test('MCP v2 client auto-negotiates with the current stdio server', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'digestseo-mcp-v2-client-'));
  const client = new Client({ name: 'digestseo-v2-client-compat', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH],
    env: { ...process.env, OPENAI_API_KEY:'', ANTHROPIC_API_KEY:'', GEMINI_API_KEY:'', PERPLEXITY_API_KEY:'', SERPAPI_API_KEY:'', DIGESTSEO_DB_PATH:join(tmp, 'compat.sqlite') },
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'legacy');
    assert.equal(client.getDiscoverResult(), undefined);
    assert.equal(client.getServerVersion()?.name, 'digestseo-mcp');
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
  } finally {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
