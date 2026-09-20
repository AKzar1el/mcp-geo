import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('remote Worker enables MCP 2026-07-28 CIMD with the required SSRF guard', () => {
  const workerSource = readFileSync('src/index.ts', 'utf8');
  const wranglerTemplate = readFileSync('wrangler.example.jsonc', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    devDependencies?: Record<string, string>;
  };

  assert.match(workerSource, /clientIdMetadataDocumentEnabled:\s*true/);
  assert.match(wranglerTemplate, /"global_fetch_strictly_public"/);
  assert.equal(
    pkg.devDependencies?.['@cloudflare/workers-oauth-provider'],
    '^0.10.3',
  );
});