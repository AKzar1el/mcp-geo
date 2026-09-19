import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(
  readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'),
) as {
  tools?: Array<{ name: string; description?: string }>;
  tools_generated?: boolean;
};

const expectedTools = [
  'track_brand',
  'list_brands',
  'generate_prompts',
  'refresh_brand',
  'check_visibility',
  'get_visibility_history',
  'compare_competitors',
  'get_citations',
  'get_content_gaps',
];

test('MCPB manifest declares every fixed local stdio tool', () => {
  assert.equal(manifest.tools_generated ?? false, false);
  assert.equal(manifest.tools?.length, expectedTools.length);
  assert.deepEqual(
    [...(manifest.tools ?? []).map((tool) => tool.name)].sort(),
    [...expectedTools].sort(),
  );
  for (const tool of manifest.tools ?? []) {
    assert.ok(tool.description?.trim(), `${tool.name} needs a manifest description`);
  }
});
