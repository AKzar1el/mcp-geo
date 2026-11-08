import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTools } from '../../src/core/tools.ts';
import type { Db } from '../../src/db/types.ts';

test('history, comparison and citation windows accept whole days only', () => {
  const schemas = new Map<string, z.ZodType>();
  const server = {
    registerTool(name: string, config: { inputSchema?: Record<string, z.ZodType> }) {
      if (config.inputSchema) schemas.set(name, z.object(config.inputSchema));
    },
  } as unknown as McpServer;

  registerTools(server, {
    db: {} as Db,
    env: {},
    refreshExecution: 'sync',
    runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
  });

  for (const [toolName, maximum] of [
    ['get_visibility_history', 365],
    ['compare_competitors', 90],
    ['get_citations', 90],
  ] as const) {
    const schema = schemas.get(toolName);
    assert.ok(schema, `${toolName} is registered`);
    for (const days of [1, maximum]) {
      assert.equal(schema.safeParse({ brand_id: 'acme', days }).success, true, `${toolName}: ${days}`);
    }
    for (const days of [0, maximum + 1, 1.5]) {
      assert.equal(schema.safeParse({ brand_id: 'acme', days }).success, false, `${toolName}: ${days}`);
    }
  }
});
