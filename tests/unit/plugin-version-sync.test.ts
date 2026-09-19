import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readVersion(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

test('marketplace plugin manifests track the published package version', () => {
  const packageVersion = readVersion('package.json');

  assert.equal(readVersion('.cursor-plugin/plugin.json'), packageVersion);
  assert.equal(readVersion('.claude-plugin/plugin.json'), packageVersion);
});
