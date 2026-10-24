import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandler } from 'agents/mcp/server';
import { McpServer as StatelessMcpServer } from '@modelcontextprotocol/server';
import type { McpServer as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../../src/db/types.js';
import { registerTools } from '../../src/core/tools.js';
import {
  boundHostedMcpRequestBody,
  MAX_MCP_HTTP_BODY_BYTES,
  MAX_MCP_TOOL_INPUT_ELEMENTS,
} from '../../src/core/mcp-limits.js';

function createSharedToolServer() {
  const server = new StatelessMcpServer(
    {
      name: 'digestseo-mcp',
      title: 'GEO Tracker by DigestSEO',
      description:
        'Track brand citations across seven AI search surfaces. Free OSS; optional EUR 99 client-ready audit.',
      version: 'test',
      websiteUrl: 'https://digestseo.com/geo-mcp/',
    },
    { maxToolInputElements: MAX_MCP_TOOL_INPUT_ELEMENTS },
  );

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
      ...(method === 'tools/call' && typeof params.name === 'string'
        ? { 'mcp-name': params.name }
        : {}),
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

async function invokeBounded(
  handler: ReturnType<typeof createMcpHandler>,
  request: Request,
): Promise<Response> {
  const bounded = await boundHostedMcpRequestBody(request);
  if (bounded.rejection) return bounded.rejection;
  return handler(
    bounded.request,
    {},
    { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
  );
}

test('shared hosted tools run on the SDK v2 stateless handler with legacy fallback', async () => {
  const handler = createMcpHandler(createSharedToolServer, {
    route: '/mcp',
    legacy: 'stateless',
    allowedHostnames: ['example.com'],
    allowedOriginHostnames: ['example.com'],
    maxRequestBodySize: MAX_MCP_HTTP_BODY_BYTES,
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
    maxRequestBodySize: MAX_MCP_HTTP_BODY_BYTES,
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

test('hosted MCP rejects oversized modern and legacy request bodies', async () => {
  const handler = createMcpHandler(createSharedToolServer, {
    route: '/mcp',
    legacy: 'stateless',
    allowedHostnames: ['example.com'],
    allowedOriginHostnames: ['example.com'],
    maxRequestBodySize: MAX_MCP_HTTP_BODY_BYTES,
  });
  const tooLarge = 'x'.repeat(MAX_MCP_HTTP_BODY_BYTES);
  const normal = await invokeBounded(handler, modernRequest('tools/list'));
  assert.equal(normal.status, 200);

  const modern = await invokeBounded(handler, modernRequest('tools/list', { padding: tooLarge }));
  assert.equal(modern.status, 413);

  const legacy = await invokeBounded(handler, legacyRequest('tools/list', { padding: tooLarge }));
  assert.equal(legacy.status, 413);
});

test('hosted MCP rejects tool input with excessive object members before tool execution', async () => {
  const handler = createMcpHandler(createSharedToolServer, {
    route: '/mcp',
    legacy: 'stateless',
    allowedHostnames: ['example.com'],
    allowedOriginHostnames: ['example.com'],
    maxRequestBodySize: MAX_MCP_HTTP_BODY_BYTES,
  });
  const excessiveArguments = Object.fromEntries(
    Array.from({ length: MAX_MCP_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => [`field${i}`, 'x']),
  );
  const response = await invokeBounded(
    handler,
    modernRequest('tools/call', { name: 'visibility.history', arguments: excessiveArguments }),
  );
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const body = JSON.parse(responseText) as { result?: { isError?: boolean } };
  assert.equal(body.result?.isError, true);
});
