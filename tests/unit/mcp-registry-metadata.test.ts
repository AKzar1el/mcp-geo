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
const publishWorkflow = readFileSync('.github/workflows/publish-mcp.yml', 'utf8');

test('MCP Registry description fits the registry limit and preserves the audit offer', () => {
  assert.ok(server.description.length <= 100);
  assert.match(server.description, /free OSS/i);
  assert.match(server.description, /EUR 99/i);
});

test('MCP Registry package advertises provider keys plus the non-secret AI Mode opt-in', () => {
  const environmentVariables = server.packages[0]?.environmentVariables ?? [];
  const providerNames = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'PERPLEXITY_API_KEY',
    'XAI_API_KEY',
    'SERPAPI_API_KEY',
  ];
  const byName = new Map(environmentVariables.map((entry) => [entry.name, entry]));

  for (const name of providerNames) {
    const entry = byName.get(name);
    assert.ok(entry, `${name} must be published`);
    assert.equal(entry.isRequired, false, `${name} must remain opt-in`);
    assert.equal(entry.isSecret, true, `${name} must be marked secret`);
    assert.equal(entry.format, 'string');
    assert.ok(entry.description.trim());
  }

  const aiModeFlag = byName.get('SERPAPI_AI_MODE_ENABLED');
  assert.ok(aiModeFlag, 'SERPAPI_AI_MODE_ENABLED must be published');
  assert.equal(aiModeFlag.isRequired, false);
  assert.equal(aiModeFlag.isSecret, false, 'AI Mode feature flag is not a credential');
  assert.equal(aiModeFlag.format, 'string');
  assert.match(aiModeFlag.description, /separate SerpAPI request per prompt/i);
  assert.equal(environmentVariables.length, providerNames.length + 1);
});

test('main-branch metadata validation does not republish immutable Registry versions', () => {
  const registryJob = publishWorkflow.split('  publish-mcp-registry:')[1] ?? '';

  assert.ok(registryJob, 'publish-mcp-registry job must exist');
  assert.match(
    registryJob,
    /github\.event_name == 'release' \|\| github\.event_name == 'workflow_dispatch'/,
  );
  assert.doesNotMatch(registryJob, /github\.event_name == 'push'/);
  assert.doesNotMatch(publishWorkflow, /  check-npm-version:/);
});
