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
