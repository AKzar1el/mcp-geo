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
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

function captureHostedToolConfigs(
  refreshExecution: 'async' | 'sync' = 'async',
  namespaced = true,
): Map<string, ToolConfig> {
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
      refreshExecution,
      runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
    },
    { namespaced },
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

test('hosted tools expose titles and complete safety annotations', () => {
  const tools = captureHostedToolConfigs();

  assert.equal(tools.size, 6, 'expected the six hosted visibility tools');
  for (const [name, config] of tools) {
    assert.ok(config.title?.trim(), `${name} is missing a non-empty title`);
    assert.ok(config.annotations, `${name} is missing annotations`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const) {
      assert.notEqual(
        config.annotations[hint],
        undefined,
        `${name} must explicitly declare ${hint}`,
      );
    }
  }

  assert.deepEqual(tools.get('visibility.refresh')?.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  });
});

test('refresh descriptions disclose billed calls and full prompt reruns on partial retry', () => {
  for (const [mode, namespaced, name] of [
    ['async', true, 'visibility.refresh'],
    ['sync', false, 'refresh_brand'],
  ] as const) {
    const description = captureHostedToolConfigs(mode, namespaced).get(name)?.description;
    assert.match(description ?? '', /provider API requests may incur charges/i);
    assert.match(description ?? '', /retries rerun every active prompt/i);
    assert.ok(description && description.length <= 240, `${name} description is too long`);
  }
});

test('local management tools expose precise Claude Desktop safety metadata', () => {
  const tools = captureLocalManagementToolConfigs();

  assert.equal(tools.size, 6, 'expected the six local management tools');

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

  assert.deepEqual(tools.get('update_brand'), {
    ...tools.get('update_brand'),
    title: 'Update tracked brand',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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

  assert.deepEqual(tools.get('list_prompts'), {
    ...tools.get('list_prompts'),
    title: 'List active prompts',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });

  assert.deepEqual(tools.get('set_prompts'), {
    ...tools.get('set_prompts'),
    title: 'Set active prompts',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
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
