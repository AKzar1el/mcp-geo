import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const marketplace = JSON.parse(
  readFileSync('.claude-plugin/marketplace.json', 'utf8'),
) as {
  name?: string;
  owner?: { name?: string; url?: string };
  plugins?: Array<{
    name?: string;
    source?: string;
    description?: string;
  }>;
};
const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8')) as {
  name?: string;
  description?: string;
};
const portableMcp = JSON.parse(readFileSync('.mcp.json', 'utf8')) as {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
};
const readme = readFileSync('README.md', 'utf8');
const llmsInstall = readFileSync('llms-install.md', 'utf8');

test('owner-controlled Claude marketplace installs the existing local MCP plugin', () => {
  assert.equal(marketplace.name, 'digestseo-mcp');
  assert.equal(marketplace.owner?.name, 'DigestSEO');
  assert.equal(marketplace.owner?.url, 'https://digestseo.com/geo-mcp/');
  assert.equal(marketplace.plugins?.length, 1);

  const entry = marketplace.plugins?.[0];
  assert.equal(entry?.name, plugin.name);
  assert.equal(entry?.source, './');
  assert.match(entry?.description ?? '', /AI visibility/i);
  assert.match(entry?.description ?? '', /Google AI Mode/);
  assert.match(plugin.description ?? '', /Google AI Mode/);

  const server = portableMcp.mcpServers?.['digestseo-geo'];
  assert.equal(server?.command, 'npx');
  assert.deepEqual(server?.args, ['-y', '@digestseo/mcp-geo']);
});

test('Claude marketplace install commands stay documented', () => {
  for (const doc of [readme, llmsInstall]) {
    assert.match(doc, /\/plugin marketplace add AKzar1el\/mcp-geo/);
    assert.match(doc, /\/plugin install digestseo-geo@digestseo-mcp/);
  }
});

test('GitLab Duo CLI reuses the owner-controlled marketplace without a second package', () => {
  for (const doc of [readme, llmsInstall]) {
    assert.match(
      doc,
      /glab duo plugin marketplace add https:\/\/github\.com\/AKzar1el\/mcp-geo\.git/,
    );
    assert.match(doc, /glab duo plugin install digestseo-geo@digestseo-mcp/);
  }
});
