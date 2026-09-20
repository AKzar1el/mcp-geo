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
  assert.match(
    guide,
    /### Amazon Q Developer \(IDE\)[\s\S]*STDIO[\s\S]*Command: `npx`[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(
    guide,
    /### ChatGPT[\s\S]*does \*\*not\*\* connect directly to local STDIO MCP servers[\s\S]*Use \*\*Path B\*\*/,
  );
  assert.doesNotMatch(guide, /### ChatGPT desktop app[\s\S]*npx -y @digestseo\/mcp-geo/);
  assert.match(
    guide,
    /### Codex CLI[\s\S]*codex mcp add digestseo -- npx -y @digestseo\/mcp-geo[\s\S]*codex mcp list/,
  );
  assert.match(
    guide,
    /### OpenCode v2[\s\S]*opencode mcp add digestseo --global -- npx -y @digestseo\/mcp-geo[\s\S]*mcp\.servers[\s\S]*opencode mcp list/,
  );
});

test('AI-agent guide documents JetBrains AI Assistant local stdio setup', () => {
  assert.match(
    guide,
    /### JetBrains AI Assistant \(IDE\)[\s\S]*Add > STDIO[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
});
test('AI-agent guide documents Roo Code global and project stdio setup', () => {
  assert.match(guide, /### Roo Code[\s\S]*Edit Global MCP[\s\S]*\.roo\/mcp\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/);
  assert.match(guide, /Roo's documented fallback[\s\S]*"command": "cmd"/);
});
test('AI-agent guide does not hard-code Gemini quota assumptions', () => {
  assert.match(guide, /active Gemini API limits in Google AI Studio/);
  assert.match(guide, /limits vary by model, project, and usage tier/);
  assert.doesNotMatch(guide, /Gemini free-tier rate limit; drop the key or upgrade/);
});
