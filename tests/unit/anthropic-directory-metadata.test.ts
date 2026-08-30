import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/core/tools.ts';
import type { Db } from '../../src/db/types.ts';

type ToolConfig = {
  title?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
};

function captureHostedToolConfigs(): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  const server = {
    registerTool(name: string, config: ToolConfig) {
      tools.set(name, config);
    },
  } as unknown as McpServer;

  registerTools(
    server,
    {
      db: {} as Db,
      env: {},
      refreshExecution: 'async',
      runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
    },
    { namespaced: true },
  );

  return tools;
}

test('hosted tools expose Claude Directory titles and safety annotations', () => {
  const tools = captureHostedToolConfigs();

  assert.equal(tools.size, 6, 'expected the six hosted visibility tools');
  for (const [name, config] of tools) {
    assert.ok(config.title?.trim(), `${name} is missing a non-empty title`);
    assert.ok(config.annotations, `${name} is missing annotations`);
    assert.ok(
      config.annotations.readOnlyHint === true || config.annotations.destructiveHint === true,
      `${name} must be explicitly read-only or destructive`,
    );
  }
});
