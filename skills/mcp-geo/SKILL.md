---
name: mcp-geo
description: Help users safely install and use DigestSEO mcp-geo for measured AI-search brand visibility, citations, competitive comparisons, and evidence-grounded content gaps through an MCP-capable assistant.
---

# mcp-geo: evidence-first AI visibility

Use the free, self-hostable [DigestSEO mcp-geo](https://github.com/AKzar1el/mcp-geo). This skill is workflow guidance only; installing it does not install or connect the server or authorize any provider spending.

## Connect safely

1. Confirm the user's MCP host and whether it supports local STDIO or requires a self-hosted remote MCP endpoint. Local installs require Node.js 22.13+.
2. For local STDIO, set command `npx` and arguments `-y`, `@digestseo/mcp-geo` in the host's MCP server settings. Example:

   ```json
   {"mcpServers":{"digestseo":{"command":"npx","args":["-y","@digestseo/mcp-geo"]}}}
   ```

3. Tool discovery and local brand/prompt management work without provider credentials. A live scan sends the selected prompts to the user's chosen providers and may incur provider charges. Obtain authorization before configuring keys or invoking paid engine operations. Store keys only in the user's host secret/environment settings, not in code, saved reports, or chat transcripts.
4. ChatGPT and other remote-only hosts do not run local STDIO. Use the user's own OAuth-protected remote Worker and the [security guide](https://github.com/AKzar1el/mcp-geo/blob/main/SECURITY.md). The public demo endpoint is not a turnkey free provider-funded scan service.

## Evidence-first workflow

- Ask for the exact brand/domain, named competitors, buyer-intent prompts, selected engines, date/window, and evaluation objective.
- Discover the connected server's actual tools with MCP `tools/list`; local STDIO tool names are flat, while remote Worker tool names use `visibility.*`. Use the [README](https://github.com/AKzar1el/mcp-geo) for current schemas, not guessed tool arguments.
- With authorization, select/create the local brand and prompt set. Check the requested prompt count before any provider-backed scan. Do not silently increase usage.
- Report brand mentions, usable-prompt denominators, citation URLs/excerpts, competitive evidence, and losing prompts separately. Distinguish missing/failed provider data from genuine zero mentions.
- Provide only recommendations traceable to observed prompt and citation data. Use the [audit methodology](https://github.com/AKzar1el/mcp-geo/blob/main/docs/ai-visibility-audit-methodology.md) and [reusable report prompt](https://github.com/AKzar1el/mcp-geo/blob/main/docs/ai-visibility-audit-report-prompt.md). Do not fabricate citations, guarantee rankings, or claim that observations prove conversions.

## Optional human-led service

The existing [EUR 99 one-time AI Visibility Audit](https://geo-mcp.digestseo.com/audit) is separate from the free software. Do not initiate purchases, billing, or outreach on the user's behalf.
