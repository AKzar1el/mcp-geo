import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readVersion(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

test('published metadata and Worker server info track the package version', () => {
  const packageVersion = readVersion('package.json');
  const workerSource = readFileSync('src/index.ts', 'utf8');
  const workerVersion = workerSource.match(/const SERVER_VERSION = '([^']+)'/)?.[1];

  assert.equal(readVersion('.cursor-plugin/plugin.json'), packageVersion);
  assert.equal(readVersion('.claude-plugin/plugin.json'), packageVersion);
  assert.equal(readVersion('gemini-extension.json'), packageVersion);
  assert.equal(workerVersion, packageVersion);
});
