# Windsurf / Devin Desktop

mcp-geo works with Windsurf / Devin Desktop through Cascade's native MCP support.

## Local stdio setup (recommended)

For a local installation with your own engine API keys:

```json
{
  "mcpServers": {
    "digestseo-geo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"],
      "env": {
        "OPENAI_API_KEY": "${env:OPENAI_API_KEY}",
        "ANTHROPIC_API_KEY": "${env:ANTHROPIC_API_KEY}",
        "GEMINI_API_KEY": "${env:GEMINI_API_KEY}",
        "PERPLEXITY_API_KEY": "${env:PERPLEXITY_API_KEY}",
        "XAI_API_KEY": "${env:XAI_API_KEY}",
        "SERPAPI_API_KEY": "${env:SERPAPI_API_KEY}"
      }
    }
  }
}
```

Set only the engine keys you intend to use; unconfigured engines are skipped.

## Self-hosted Worker setup

If you deploy the Worker yourself with the engine API keys you intend to use, point Windsurf at your own `/mcp` URL:

```json
{
  "mcpServers": {
    "digestseo-geo": {
      "serverUrl": "https://YOUR-WORKER.example.workers.dev/mcp"
    }
  }
}
```

The public `geo-mcp.digestseo.com/mcp` endpoint is not a turnkey fresh-scan service. Do not use it as a no-key substitute for a configured Worker.

## Verify

Reload Windsurf after changing the config, open Cascade's MCP settings, confirm `digestseo-geo` connects, then inspect its tool list before invoking a tool.

- Product: https://digestseo.com/geo-mcp/
- Official MCP Registry ID: `io.github.AKzar1el/mcp-geo`
- Windsurf MCP docs: https://docs.devin.ai/desktop/cascade/mcp
