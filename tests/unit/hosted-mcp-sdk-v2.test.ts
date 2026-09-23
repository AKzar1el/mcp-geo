import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandler } from 'agents/mcp/server';
import { McpServer as StatelessMcpServer } from '@modelcontextprotocol/server';
import type { McpServer as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../../src/db/types.js';
import { registerTools } from '../../src/core/tools.js';

function createSharedToolServer() {
  const server = new StatelessMcpServer({
    name: 'digestseo-mcp',
    title: 'GEO Tracker by DigestSEO',
    description:
      'Track brand citations across seven AI search surfaces. Free OSS; optional EUR 99 client-ready audit.',
    version: 'test',
    websiteUrl: 'https://digestseo.com/geo-mcp/',
  });

  registerTools(
    server as unknown as LegacyMcpServer,
    {
      db: {} as Db,
      env: {},
      refreshExecution: 'async',
      runEnginesInline: async () => ({ run_ids: {}, engines: [] }),
    },
    { namespaced: true },
  );
  return server;
}

function legacyRequest(method: string, params: Record<string, unknown>) {
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: {
      host: 'example.com',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function modernRequest(method: string, params: Record<string, unknown> = {}) {
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: {
      host: 'example.com',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'modern-compat-test',
            version: '1',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

test('shared hosted tools run on the SDK v2 stateless handler with legacy fallback', async () => {
  const handler = createMcpHandler(createSharedToolServer, {
    route: '/mcp',
    legacy: 'stateless',
    allowedHostnames: ['example.com'],
    allowedOriginHostnames: ['example.com'],
  });

  const initialize = legacyRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'compat-test', version: '1' },
  });
  const initializeResponse = await handler(
    initialize,
    {},
    { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
  );
  assert.equal(initializeResponse.status, 200);
  assert.match(await initializeResponse.text(), /"name":"digestseo-mcp"/);

  const listResponse = await handler(
    legacyRequest('tools/list', {}),
    {},
    { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
  );
  assert.equal(listResponse.status, 200);
  const body = await listResponse.text();
  for (const tool of [
    'visibility.check',
    'visibility.history',
    'visibility.compare',
    'visibility.citations',
    'visibility.content_gaps',
    'visibility.refresh',
  ]) {
    assert.match(body, new RegExp(`"name":"${tool.replace('.', '\\.')}`));
  }
});

test('shared hosted tools support the MCP 2026-07-28 modern stateless flow', async () => {
  const handler = createMcpHandler(createSharedToolServer, {
    route: '/mcp',
    legacy: 'stateless',
    allowedHostnames: ['example.com'],
    allowedOriginHostnames: ['example.com'],
  });

  const discoverResponse = await handler(
    modernRequest('server/discover'),
    {},
    { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
  );
  assert.equal(discoverResponse.status, 200);
  assert.equal(discoverResponse.headers.get('mcp-session-id'), null);
  const discover = JSON.parse(await discoverResponse.text());
  assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
  assert.equal(
    discover.result._meta['io.modelcontextprotocol/serverInfo'].name,
    'digestseo-mcp',
  );
  assert.equal(
    discover.result._meta['io.modelcontextprotocol/serverInfo'].title,
    'GEO Tracker by DigestSEO',
  );
  assert.equal(
    discover.result._meta['io.modelcontextprotocol/serverInfo'].description,
    'Track brand citations across seven AI search surfaces. Free OSS; optional EUR 99 client-ready audit.',
  );
  assert.equal(
    discover.result._meta['io.modelcontextprotocol/serverInfo'].websiteUrl,
    'https://digestseo.com/geo-mcp/',
  );

  const listResponse = await handler(
    modernRequest('tools/list'),
    {},
    { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
  );
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get('mcp-session-id'), null);
  const listed = JSON.parse(await listResponse.text());
  const names = listed.result.tools.map((tool: { name: string }) => tool.name);
  assert.deepEqual(names.sort(), [
    'visibility.check',
    'visibility.citations',
    'visibility.compare',
    'visibility.content_gaps',
    'visibility.history',
    'visibility.refresh',
  ]);
});
