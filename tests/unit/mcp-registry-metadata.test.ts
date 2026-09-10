import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = JSON.parse(readFileSync('server.json', 'utf8')) as {
  description: string;
};

test('MCP Registry description fits the registry limit and preserves the audit offer', () => {
  assert.ok(server.description.length <= 100);
  assert.match(server.description, /free OSS/i);
  assert.match(server.description, /EUR 99/i);
});
