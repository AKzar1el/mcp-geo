import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const skill = readFileSync('skills/mcp-geo/SKILL.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');

test('repository-native GEO Agent Skill has discoverable metadata and a documented installer', () => {
  assert.match(skill, /^---\r?\nname: mcp-geo\r?\ndescription: [^\r\n]+\r?\n---\r?\n/);
  assert.match(readme, /npx skills add AKzar1el\/mcp-geo --skill mcp-geo/);
});

test('skill distinguishes instructions from MCP transport and paid provider usage', () => {
  assert.match(skill, /@digestseo\/mcp-geo/);
  assert.match(skill, /Node\.js 22\.13\+/);
  assert.match(skill, /without provider credentials/);
  assert.match(skill, /may incur provider charges/);
  assert.match(skill, /OAuth-protected remote Worker/);
  assert.match(skill, /usable-prompt denominators/);
  assert.match(skill, /EUR 99 one-time AI Visibility Audit/);
});
