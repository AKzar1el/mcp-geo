// Hosted MCP accepts small tool arguments, never arbitrary bulk documents.
// Bound both JSON body bytes and nested tool-argument collection cardinality
// to prevent request-driven validation memory exhaustion (GHSA-46jr-4wx8-v453).
export const MAX_MCP_HTTP_BODY_BYTES = 256 * 1024;
export const MAX_MCP_TOOL_INPUT_ELEMENTS = 1_024;

function tooLargeResponse(): Response {
  return new Response(JSON.stringify({ error: 'MCP request body exceeds 256 KiB' }), {
    status: 413,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// The Agents legacy-compatibility route does not forward maxRequestBodySize
// to its fallback transport. Enforce the same bound before either route parses
// JSON, including requests without a Content-Length header.
export async function boundHostedMcpRequestBody(
  request: Request,
): Promise<{ request: Request; rejection: Response | null }> {
  if (request.method.toUpperCase() !== 'POST' || !request.body) {
    return { request, rejection: null };
  }

  const reportedLength = request.headers.get('content-length');
  if (reportedLength && /^\d+$/.test(reportedLength) && Number(reportedLength) > MAX_MCP_HTTP_BODY_BYTES) {
    return { request, rejection: tooLargeResponse() };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_MCP_HTTP_BODY_BYTES) {
        await reader.cancel('MCP request body limit exceeded');
        return { request, rejection: tooLargeResponse() };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const boundedBody = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    boundedBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { request: new Request(request, { body: boundedBody }), rejection: null };
}
