import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>;
};
const sqlitePackage = JSON.parse(
  readFileSync(require.resolve('better-sqlite3/package.json'), 'utf8'),
) as {
  version: string;
  exports?: Record<string, unknown>;
};

test('MCPB sqlite dependency uses the N-API release with bundled cross-platform prebuild selectors', () => {
  assert.match(
    packageJson.dependencies?.['better-sqlite3'] ?? '',
    /^\^13\./,
    'better-sqlite3 must stay on the N-API-based v13 line for portable MCPB bundles',
  );

  assert.match(sqlitePackage.version, /^13\./);

  for (const target of [
    './darwin-x64',
    './darwin-arm64',
    './linux-x64',
    './linux-arm64',
    './win32-x64',
    './win32-arm64',
  ]) {
    assert.ok(
      sqlitePackage.exports?.[target],
      `better-sqlite3 is missing its bundled ${target} prebuild selector`,
    );
  }
});
