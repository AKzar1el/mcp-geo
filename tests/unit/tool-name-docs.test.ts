import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { HOSTED_SERVER_INSTRUCTIONS, LOCAL_SERVER_INSTRUCTIONS } from '../../src/core/server-instructions.ts';

const read = (path: string) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const pairs = [
  ['check_visibility', 'visibility.check'],
  ['get_visibility_history', 'visibility.history'],
  ['compare_competitors', 'visibility.compare'],
  ['get_citations', 'visibility.citations'],
  ['get_content_gaps', 'visibility.content_gaps'],
  ['refresh_brand', 'visibility.refresh'],
] as const;

test('MCP initialization guides scoped, provider-free observation evidence inspection', () => {
  const toolsSource = read('src/core/tools.ts');
  assert.match(toolsSource, /get_observation_evidence: 'visibility\.observation_evidence'/);

  for (const [instructions, name] of [
    [LOCAL_SERVER_INSTRUCTIONS, 'get_observation_evidence'],
    [HOSTED_SERVER_INSTRUCTIONS, 'visibility.observation_evidence'],
  ]) {
    assert.ok(instructions.includes(name), `${name} is missing from initialization guidance`);
    for (const field of ['brand_id', 'run_id', 'response_id', 'active_prompt', 'identity_scope', 'measurement_mode']) {
      assert.ok(instructions.includes(field), `${name} guidance omits ${field}`);
    }
    assert.match(instructions, /without provider calls/i);
    assert.match(instructions, /not independently verified (?:source )?citations/i);
  }
});

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

test('client audit report instructions account for paginated citation evidence', () => {
  const report = read('docs/ai-visibility-audit-report-prompt.md');
  const toolsSource = read('src/core/tools.ts');

  assert.match(toolsSource, /has_more: hasMore/);
  assert.match(toolsSource, /next_cursor: hasMore/);
  assert.match(report, /`has_more`/);
  assert.match(report, /`next_cursor`/);
  assert.match(report, /same.*`brand_id`.*`days`.*`engines`.*`measurement_mode`/);
  assert.match(report, /`top_sources`.*full.*window/i);
  assert.match(report, /partial.*citation.*examples/i);
});

test('client audit report instructions require a no-call refresh scope preview before spending', () => {
  const report = read('docs/ai-visibility-audit-report-prompt.md');
  const toolsSource = read('src/core/tools.ts');

  assert.match(toolsSource, /preview_only: z\.boolean\(\)\.default\(false\)/);
  assert.match(report, /refresh_brand\(preview_only=true/);
  for (const field of [
    'ready_to_refresh',
    'planned_engines',
    'active_prompt_count',
    'planned_prompt_engine_pairs',
    'skipped_unconfigured_engines',
    'readiness_warnings',
    'cost_note',
  ]) {
    assert.ok(report.includes('`' + field + '`'), `Audit report omits ${field} preview guidance`);
  }
  assert.match(report, /partial.*engine.*scope/i);
  assert.match(report, /not.*billing.*(quote|estimate)/i);
});
