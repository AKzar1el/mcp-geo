import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync('.cursor-plugin/plugin.json', 'utf8')) as {
  variables?: {
    type?: string;
    properties?: Record<string, unknown>;
  };
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
};

const providerKeys = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'PERPLEXITY_API_KEY',
  'SERPAPI_API_KEY',
];

test('Cursor plugin exposes optional provider-key configuration without changing portable MCP config', () => {
  assert.equal(manifest.variables?.type, 'object');
  const properties = manifest.variables?.properties ?? {};
  const server = manifest.mcpServers?.['digestseo-geo'];

  assert.equal(server?.command, 'npx');
  assert.deepEqual(server?.args, ['-y', '@digestseo/mcp-geo']);

  for (const key of providerKeys) {
    assert.ok(properties[key], `Cursor plugin should declare ${key}`);
    assert.equal(server?.env?.[key], '$' + '{' + key + '}');
  }

  const portableConfig = JSON.parse(readFileSync('.mcp.json', 'utf8')) as {
    mcpServers?: Record<string, { env?: Record<string, string> }>;
  };
  assert.equal(portableConfig.mcpServers?.['digestseo-geo']?.env, undefined);
});