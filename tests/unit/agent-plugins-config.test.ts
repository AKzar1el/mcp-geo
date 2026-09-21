import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const plugin = JSON.parse(readFileSync('plugin.json', 'utf8')) as {
  $schema?: string;
  name?: string;
  repository?: string;
};

const mcp = JSON.parse(readFileSync('mcp.json', 'utf8')) as {
  $schema?: string;
  mcpServers?: Record<
    string,
    {
      type?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
};

test('Agent Plugins 1.0 metadata exposes the zero-key local stdio package', () => {
  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(plugin.name, 'digestseo-geo');
  assert.equal(plugin.repository, 'https://github.com/AKzar1el/mcp-geo');

  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  const server = mcp.mcpServers?.['digestseo-geo'];
  assert.equal(server?.type, 'stdio');
  assert.equal(server?.command, 'npx');
  assert.deepEqual(server?.args, ['-y', '@digestseo/mcp-geo']);
  assert.equal(server?.env, undefined);

  const directMcp = JSON.parse(readFileSync('.mcp.json', 'utf8')) as {
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
  };
  assert.equal(directMcp.mcpServers?.['digestseo-geo']?.command, server?.command);
  assert.deepEqual(directMcp.mcpServers?.['digestseo-geo']?.args, server?.args);
});
