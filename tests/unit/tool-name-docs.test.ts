import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path: string) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const pairs = [
  ['check_visibility', 'visibility.check'],
  ['get_visibility_history', 'visibility.history'],
  ['compare_competitors', 'visibility.compare'],
  ['get_citations', 'visibility.citations'],
  ['get_content_gaps', 'visibility.content_gaps'],
  ['refresh_brand', 'visibility.refresh'],
] as const;

test('hosted Worker and local stdio tool names stay explicitly mapped in docs', () => {
  const toolsSource = read('src/core/tools.ts');
  const readme = read('README.md');
  const setup = read('SETUP.md');

  for (const [localName, hostedName] of pairs) {
    assert.ok(toolsSource.includes(`${localName}: '${hostedName}'`));
    assert.ok(readme.includes(`| \`${hostedName}\` | \`${localName}\` |`));
  }

  for (const hostedName of [
    'visibility.check',
    'visibility.compare',
    'visibility.citations',
    'visibility.content_gaps',
    'visibility.refresh',
  ]) {
    assert.ok(setup.includes(`\`${hostedName}\``));
  }

  assert.ok(setup.includes('local stdio'));
  assert.ok(setup.includes('`check_visibility`'));
  assert.ok(setup.includes('`refresh_brand`'));
  assert.doesNotMatch(setup, /Claude will call `check_visibility`/);
});