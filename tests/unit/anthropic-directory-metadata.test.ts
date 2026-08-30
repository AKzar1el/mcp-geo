import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerLocalManagementTools,
  registerTools,
} from '../../src/core/tools.ts';
import type { Db } from '../../src/db/types.ts';

type ToolConfig = {
  title?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
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

function captureLocalManagementToolConfigs(): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  const server = {
    registerTool(name: string, config: ToolConfig) {
      tools.set(name, config);
    },
  } as unknown as McpServer;

  registerLocalManagementTools(server, {
    db: {} as Db,
    env: {},
  });

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

test('local management tools expose precise Claude Desktop safety metadata', () => {
  const tools = captureLocalManagementToolConfigs();

  assert.equal(tools.size, 3, 'expected the three local management tools');

  assert.deepEqual(tools.get('track_brand'), {
    ...tools.get('track_brand'),
    title: 'Track a brand',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  });

  assert.deepEqual(tools.get('list_brands'), {
    ...tools.get('list_brands'),
    title: 'List tracked brands',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });

  assert.deepEqual(tools.get('generate_prompts'), {
    ...tools.get('generate_prompts'),
    title: 'Generate brand prompts',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  });
});
