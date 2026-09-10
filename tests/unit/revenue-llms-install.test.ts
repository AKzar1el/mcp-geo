import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const guide = readFileSync('llms-install.md', 'utf8');

test('AI-agent install guide exposes the frozen managed audit alternative without displacing OSS', () => {
  assert.match(guide, /Path C \(optional\): managed AI Visibility Audit/i);
  assert.match(guide, /EUR 99 one-time/i);
  assert.match(guide, /20 buyer-intent prompts/i);
  assert.match(guide, /up to three competitors/i);
  assert.match(guide, /open-source package remains free/i);
  assert.match(
    guide,
    /mailto:info@tomiseregi\.si\?subject=mcp-geo%20AI%20Visibility%20Audit%20-%20EUR%2099&body=[^\s)]*Source%3A%20mcp-geo%20llms-install/,
  );
});
