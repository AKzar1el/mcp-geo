import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../../src/db/types.js';
import {
  registerLocalManagementTools,
  registerTools,
} from '../../src/core/tools.js';

interface CapturedConfig {
  description?: string;
  inputSchema?: Record<string, { description?: string }>;
}

function captureToolConfigs(): Map<string, CapturedConfig> {
  const configs = new Map<string, CapturedConfig>();
  const server = {
    registerTool(name: string, config: CapturedConfig) {
      configs.set(name, config);
      return {};
    },
  } as unknown as McpServer;
  const db = {} as Db;

  registerTools(server, {
    db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });
  registerLocalManagementTools(server, { db, env: {} });
  return configs;
}

test('all twelve tool schemas stay lean, example-led, and parameter-described', () => {
  const configs = captureToolConfigs();
  assert.equal(configs.size, 12);

  for (const [name, config] of configs) {
    assert.ok(config.description, `${name} needs a description`);
    assert.match(config.description, /Example:/, `${name} needs one short usage example`);
    assert.ok(
      config.description.length <= 240,
      `${name} description should stay lean (${config.description.length} chars)`,
    );

    for (const [parameter, schema] of Object.entries(config.inputSchema ?? {})) {
      assert.ok(
        schema.description,
        `${name}.${parameter} needs a parameter description`,
      );
      assert.ok(
        schema.description.length <= 100,
        `${name}.${parameter} description should stay lean (${schema.description.length} chars)`,
      );
    }
  }
});
