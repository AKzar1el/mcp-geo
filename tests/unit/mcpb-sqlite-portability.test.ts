import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  engines?: { node?: string };
};
const manifest = JSON.parse(
  readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'),
) as {
  compatibility?: { runtimes?: { node?: string } };
  user_config?: Record<string, { required?: boolean; default?: string }>;
};

test('MCPB sqlite runtime avoids native addons that Claude Desktop rejects on macOS', () => {
  assert.equal(
    packageJson.dependencies?.['better-sqlite3'],
    undefined,
    'MCPB must not bundle better-sqlite3 native .node binaries',
  );
  assert.match(
    packageJson.engines?.node ?? '',
    /22\.13/,
    'node:sqlite is flag-free from Node 22.13 onward',
  );
  assert.match(
    manifest.compatibility?.runtimes?.node ?? '',
    /22\.13/,
    'MCPB runtime metadata must match the node:sqlite floor',
  );
});


test('optional MCPB API keys resolve to empty strings when omitted', () => {
  const keys = [
    'openai_api_key',
    'anthropic_api_key',
    'gemini_api_key',
    'perplexity_api_key',
    'serpapi_api_key',
  ];
  for (const key of keys) {
    assert.equal(manifest.user_config?.[key]?.required, false);
    assert.equal(
      manifest.user_config?.[key]?.default,
      '',
      `optional user_config.${key} must default to an empty string`,
    );
  }
});
