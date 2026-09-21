import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = JSON.parse(readFileSync('server.json', 'utf8')) as {
  description: string;
  packages: Array<{
    environmentVariables?: Array<{
      name: string;
      description: string;
      isRequired: boolean;
      format: string;
      isSecret: boolean;
    }>;
  }>;
};

test('MCP Registry description fits the registry limit and preserves the audit offer', () => {
  assert.ok(server.description.length <= 100);
  assert.match(server.description, /free OSS/i);
  assert.match(server.description, /EUR 99/i);
});

test('MCP Registry package advertises optional secret provider-key configuration', () => {
  const environmentVariables = server.packages[0]?.environmentVariables ?? [];
  const expectedNames = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'PERPLEXITY_API_KEY',
    'XAI_API_KEY',
    'SERPAPI_API_KEY',
  ];

  assert.deepEqual(
    environmentVariables.map((entry) => entry.name),
    expectedNames,
  );
  for (const entry of environmentVariables) {
    assert.equal(entry.isRequired, false, `${entry.name} must remain opt-in`);
    assert.equal(entry.isSecret, true, `${entry.name} must be marked secret`);
    assert.equal(entry.format, 'string');
    assert.ok(entry.description.trim());
  }
});
