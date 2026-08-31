# Windsurf / Devin Desktop

mcp-geo works with Windsurf / Devin Desktop through Cascade's native MCP support.

## Hosted setup (recommended)

Open `~/.codeium/windsurf/mcp_config.json` and merge this server into the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "digestseo-geo": {
      "serverUrl": "https://geo-mcp.digestseo.com/mcp"
    }
  }
}
```

The hosted endpoint uses Streamable HTTP and follows its normal MCP/OAuth authentication flow. Do not replace existing MCP entries when adding this configuration.

## Local stdio setup

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
        "SERPAPI_API_KEY": "${env:SERPAPI_API_KEY}"
      }
    }
  }
}
```

Set only the engine keys you intend to use; unconfigured engines are skipped.

## Verify

Reload Windsurf after changing the config, open Cascade's MCP settings, confirm `digestseo-geo` connects, then inspect its tool list before invoking a tool.

- Product: https://digestseo.com/geo-mcp/
- Official MCP Registry ID: `io.github.AKzar1el/mcp-geo`
- Windsurf MCP docs: https://docs.devin.ai/desktop/cascade/mcp
