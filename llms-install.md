# llms-install.md — AI agent installation guide for the DigestSEO GEO Tracker

This file is written for AI agents (Cline, Claude Code, Cursor agents, etc.) installing **@digestseo/mcp-geo** (the `digestseo-mcp` executable), an MCP server that tracks how ChatGPT, Claude, Perplexity, Gemini, Grok, Google AI Overviews, and Google AI Mode cite a brand. Every command below is copy-pasteable as-is. Choose exactly one path:

- **Path A (recommended): run locally via npx** — no hosting, data stays in a local SQLite file, user brings their own AI provider API keys.
- **Path B: self-host on Cloudflare Workers** — remote MCP server with D1 storage, cron auto-refresh, and admin HTTP routes. The connect URL at the end is `https://<worker-host>/mcp`.
- **Path C (optional): managed AI Visibility Audit** — if the user wants the result without installing or operating mcp-geo, the fixed-price EUR 99 one-time audit covers one brand/domain, up to three competitors, 20 buyer-intent prompts, up to five supported AI surfaces where usable, citation/source evidence, and a prioritized action memo. The open-source package remains free.

For an agreed research/audit question set, use `set_prompts` with the exact 1-50 buyer questions instead of regenerating them. It replaces only the active prompt set, keeps historical runs intact, and makes a repeated identical call a no-op. Use `list_prompts` immediately before a scan when the exact measurement set must be verified.

For Path C, review the [audit methodology](docs/ai-visibility-audit-methodology.md) and [sample report](docs/demo-report-full.png), then [open the source-marked audit request](mailto:info@tomiseregi.si?subject=mcp-geo%20AI%20Visibility%20Audit%20-%20EUR%2099&body=Hi%20Tomi%2C%0A%0AI%27d%20like%20the%20EUR%2099%20mcp-geo%20AI%20Visibility%20Audit.%0A%0ABrand%2Fdomain%3A%0ACompetitors%20%28up%20to%203%29%3A%0AContext%20or%20priority%20%28optional%29%3A%0A%0ASource%3A%20mcp-geo%20llms-install). No subscription or sales call is required; after fit and scope are confirmed, normal invoice/payment instructions are sent.

**Security rule for agents:** API keys and secrets are entered by the **user** — into their MCP client config file (Path A) or into the terminal prompt opened by `wrangler secret put` (Path B). Never ask the user to paste a secret into the chat, and never echo a secret back.

---

## Path A (recommended): local stdio server via npx

### Requirements

- Node.js >= 22 (`node --version`)
- API keys are optional for startup and MCP tool discovery; at least one is needed for engine-backed scans

### API keys

All six keys are **optional individually**. With zero keys, the server still starts so MCP clients can discover its tools, while engine-backed scans report that no engines are available. Engines whose key is absent are skipped gracefully. Add only the provider keys the user chooses to use.

| Environment variable | Provider / engine | Where to get the key | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | OpenAI — ChatGPT engine (`gpt-5-search-api`, web search) | https://platform.openai.com/api-keys | Grounded search; OpenAI bills web-search calls plus model tokens — check current API pricing |
| `ANTHROPIC_API_KEY` | Anthropic — Claude engine (`claude-haiku-4-5`) | https://console.anthropic.com/ | Recommended starter; also powers prompt generation and `get_content_gaps` analysis |
| `GEMINI_API_KEY` | Google AI Studio — Gemini engine (`gemini-3.1-flash-lite`) | https://aistudio.google.com/app/apikey | Rate limits vary by model, project, and usage tier; check the project's active limits in Google AI Studio |
| `PERPLEXITY_API_KEY` | Perplexity — Agent API `fast` preset | https://docs.perplexity.ai/docs/agent-api/quickstart | Paid API usage; check current Agent API pricing |
| `XAI_API_KEY` | xAI — Grok engine (`grok-4.7`, web search) | https://console.x.ai/ | Paid; Web Search is billed separately from model tokens, so check current xAI pricing |
| `SERPAPI_API_KEY` | SerpAPI — Google AI Overviews + optional Google AI Mode | https://serpapi.com/dashboard | AI Mode is a separate SerpAPI call per prompt and requires the explicit flag below |
| `SERPAPI_AI_MODE_ENABLED` | Non-secret feature flag for Google AI Mode | n/a | Set to `true` only when you want AI Mode added to automatic refreshes; default/unset preserves existing SerpAPI cost |

Recommend **OpenAI + Anthropic** as the starting pair. Google AI Mode is intentionally opt-in even when `SERPAPI_API_KEY` is present so an upgrade cannot silently add SerpAPI spend. OpenAI provides grounded ChatGPT visibility through web search and bills search calls plus model tokens; Anthropic also powers prompt generation and content-gap analysis. Check current provider pricing before estimating scan cost.

Data location: SQLite database at `~/.digestseo/digestseo.sqlite`, created automatically on first start. Override with the optional `DIGESTSEO_DB_PATH` environment variable.

### Sanity check (optional)

```bash
npx -y @digestseo/mcp-geo
```

This starts the server on stdio and logs `ready on stdio` to stderr (press Ctrl+C to stop). With zero keys it still starts for MCP discovery and logs a warning; add one or more provider keys before running an engine-backed scan.

### Claude Desktop

Edit the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Merge this into the `mcpServers` object (include only the keys the user has; delete the other lines):

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"],
      "env": {
        "OPENAI_API_KEY": "sk-REPLACE_ME",
        "ANTHROPIC_API_KEY": "sk-ant-REPLACE_ME",
        "GEMINI_API_KEY": "REPLACE_ME",
        "PERPLEXITY_API_KEY": "pplx-REPLACE_ME",
        "XAI_API_KEY": "REPLACE_ME",
        "SERPAPI_API_KEY": "REPLACE_ME"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

Alternative for Claude Desktop: download the `.mcpb` desktop extension from the [latest GitHub release](https://github.com/AKzar1el/mcp-geo/releases/latest), double-click it, and enter the keys in the settings UI it presents.

### ChatGPT

ChatGPT does **not** connect directly to local STDIO MCP servers, so do not register Path A there. Use **Path B** and add the configured Worker `/mcp` URL as a custom MCP app in ChatGPT Developer Mode.

If the MCP server must stay local/private, use OpenAI Secure MCP Tunnel instead of exposing or pretending to register the local `npx` command directly. Create a tunnel in OpenAI Platform, make the desired mcp-geo provider keys available to the child process, then run:

```text
tunnel-client init --sample sample_mcp_stdio_local --profile digestseo --tunnel-id tunnel_0123456789abcdef0123456789abcdef --mcp-command "npx -y @digestseo/mcp-geo"
tunnel-client doctor --profile digestseo --explain
tunnel-client run --profile digestseo
```

Keep the client running while ChatGPT uses the server. In ChatGPT developer mode, create the app with **Tunnel** as the connection type and select the same tunnel. This private-tunnel path is not a public app submission flow. See OpenAI's current [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for tunnel creation, permissions, runtime-key setup, and troubleshooting.

### Claude Code (CLI)

```bash
claude mcp add --transport stdio digestseo -s user --env OPENAI_API_KEY=sk-REPLACE_ME -- npx -y @digestseo/mcp-geo
```

Add one `--env NAME=VALUE` flag per key the user has (before the `--`). The base form without env flags is `claude mcp add --transport stdio digestseo -s user -- npx -y @digestseo/mcp-geo`; it starts for discovery, but engine-backed scans need at least one provider key.

Alternative: install the repository's owner-controlled Claude Code plugin marketplace entry:

```text
/plugin marketplace add AKzar1el/mcp-geo
/plugin install digestseo-geo@digestseo-mcp
```

That plugin reads the repository's `.mcp.json` and launches `npx -y @digestseo/mcp-geo`. With this path, provider keys needed for scans should already be available to the Claude Code process; zero keys still allow tool discovery. Use the direct `claude mcp add` form above when per-server `--env` configuration is preferable.

### Codex CLI

```bash
codex mcp add digestseo -- npx -y @digestseo/mcp-geo
```

The base command starts the local STDIO server with zero provider keys for tool discovery. Add one `--env NAME=VALUE` option per provider key before the `--` when engine-backed scans are needed, then use `codex mcp list` to verify the server is configured.

### Amp CLI

```bash
amp mcp add digestseo -- npx -y @digestseo/mcp-geo
```

Amp launches the command as a local STDIO MCP server. The zero-key form is sufficient for tool discovery. Before engine-backed scans, make only the selected provider environment variables available to the Amp process or add them through Amp's local MCP `env` configuration; do not commit provider secrets to workspace settings.

Reference: [Amp MCP](https://ampcode.com/docs/customize/mcp).

### OpenCode v2

```bash
opencode mcp add digestseo --global -- npx -y @digestseo/mcp-geo
```

OpenCode v2 stores local MCP servers under `mcp.servers` and launches the command over STDIO. Omit `--global` for project-only configuration. The zero-key command is enough for discovery. For engine-backed scans, edit the generated config and add only the selected provider variables under `mcp.servers.digestseo.environment`, using OpenCode's environment substitution (for example `"OPENAI_API_KEY": "{env:OPENAI_API_KEY}"`) so the secret value stays in the process environment rather than in the config file. Verify the connection with `opencode mcp list`. Reference: [OpenCode v2 MCP servers](https://opencode.ai/v2/docs/mcp-servers).

### Mistral Vibe Code

Vibe Code accepts local STDIO MCP servers in either the user-level `~/.vibe/config.toml` or project-level `./.vibe/config.toml`:

```toml
[[mcp_servers]]
name = "digestseo"
transport = "stdio"
command = "npx"
args = ["-y", "@digestseo/mcp-geo"]
```

That zero-key entry is enough for MCP discovery. Before engine-backed scans, pass only the provider environment variables the user selected through Vibe's STDIO environment configuration or the environment inherited by Vibe; do not commit provider secrets to the TOML file. In Vibe, run `/mcp digestseo` (or `/mcp`) to inspect the configured server and its tools.

References: [Mistral Vibe MCP servers](https://docs.mistral.ai/vibe/code/cli/mcp-servers) and [Vibe configuration](https://docs.mistral.ai/vibe/code/cli/configuration).

### LibreChat

Add mcp-geo to LibreChat's `librechat.yaml` as a local STDIO MCP server:

```yaml
mcpServers:
  digestseo:
    type: stdio
    command: npx
    args:
      - -y
      - '@digestseo/mcp-geo'
```

Restart LibreChat after changing `librechat.yaml`. The zero-key entry is sufficient for MCP tool discovery. Before engine-backed scans, expose only the selected provider API keys to the LibreChat process instead of committing raw secret values into the YAML file.

References: [LibreChat MCP server configuration](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers) and [LibreChat MCP](https://www.librechat.ai/docs/features/mcp).

### AnythingLLM

AnythingLLM can run local command-backed MCP servers for its AI Agents. Open **Settings -> Agent Configuration -> MCP** and add the server through the MCP Management UI, or merge this entry into `anythingllm_mcp_servers.json` in AnythingLLM's storage `plugins` directory:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

STDIO is AnythingLLM's default transport for command-backed MCP servers. That zero-key configuration is sufficient for MCP tool discovery. Before engine-backed scans, add only the selected provider environment variables through AnythingLLM's MCP configuration or the process environment; do not put raw API keys into shared configuration files.

Reference: [AnythingLLM MCP compatibility](https://docs.anythingllm.com/mcp-compatibility/overview).

### Langflow

Langflow can launch external MCP servers for its agents. Open **Settings -> MCP Servers** (or the MCP sidebar -> **Add MCP Server**), choose **STDIO**, and configure:

- Name: `digestseo`
- Command: `npx`
- Arguments: `-y` and `@digestseo/mcp-geo`

That zero-key server is sufficient for MCP tool discovery. Before engine-backed scans, add only the selected provider keys in Langflow's MCP **Environment Variables** fields rather than storing raw secrets in a flow. Then select the saved server from an **MCP Tools** component and connect its tools to a Langflow Agent. If Langflow itself runs in Docker, install Node.js in the image before using an `npx` MCP server.

Reference: [Langflow MCP client](https://docs.langflow.org/mcp-client).

### Flowise

Use this path only when Flowise is running locally/self-hosted on a machine that can launch `npx`. Add a **Custom MCP** tool to an Agent and use this STDIO configuration:

```json
{"command":"npx","args":["-y","@digestseo/mcp-geo"]}
```

Refresh **Available Actions** to load the twelve mcp-geo tools. The zero-key configuration is sufficient for MCP discovery. Before an engine-backed scan, expose only the selected provider API keys to the Flowise process/service environment so its `npx` child can inherit them; do not put provider secrets into prompts or committed project files. Flowise explicitly recommends STDIO only for local instances because the MCP package runs on the Flowise host rather than in its cloud service.

Reference: [Flowise Tools & MCP](https://docs.flowiseai.com/tutorials/tools-and-mcp).

### Kilo Code

Kilo Code can launch mcp-geo as a local STDIO server from either the VS Code extension or Kilo CLI. In the extension, open **Settings -> Agent Behaviour -> MCP Servers**, add a **Local (stdio)** server named `digestseo`, and set Command to `npx` with arguments `-y` and `@digestseo/mcp-geo`. The equivalent macOS/Linux `kilo.jsonc` configuration is:

```json
{
  "mcp": {
    "digestseo": {
      "type": "local",
      "command": ["npx", "-y", "@digestseo/mcp-geo"],
      "enabled": true
    }
  }
}
```

On Windows use Kilo's documented wrapper form: `"command": ["cmd", "/c", "npx", "-y", "@digestseo/mcp-geo"]`. The zero-key configuration is sufficient for MCP tool discovery. Before engine-backed scans, add only the selected provider keys through Kilo's MCP environment settings or the local process environment; do not commit raw provider secrets into project-level `kilo.jsonc`.

References: [Using MCP in Kilo Code](https://kilo.ai/docs/automate/mcp/using-in-kilo-code) and [Using MCP in the CLI](https://kilo.ai/docs/automate/mcp/using-in-cli).

### Google Antigravity

Antigravity 2.0, Antigravity CLI, and Antigravity IDE support custom MCP servers over local STDIO. In the IDE, open the agent panel -> **MCP Servers -> Manage MCP Servers -> View raw config**. In Antigravity CLI, `/mcp` opens the interactive MCP manager. For a direct configuration, add this server either globally in `~/.gemini/config/mcp_config.json` or per workspace in `.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

That zero-key server is sufficient for MCP discovery. Before an engine-backed scan, provide only the selected provider API keys through the local MCP server environment. Keep raw provider secrets out of a workspace `.agents/mcp_config.json` that may be shared or committed.

Reference: [Google Antigravity MCP](https://www.antigravity.google/docs/mcp).

### Cherry Studio

Cherry Studio can launch local STDIO MCP servers from its desktop UI. Open **Settings -> MCP -> MCP Servers -> Add**, choose **STDIO**, and configure:

- Name: `digestseo`
- Command: `npx`
- Arguments: `-y` and `@digestseo/mcp-geo`

That zero-key server is sufficient for MCP tool discovery. Before engine-backed scans, add only the selected provider keys through Cherry Studio's MCP environment-variable fields; keep raw secrets out of prompts and screenshots. Enable the server, open its **Tools** view to verify the twelve mcp-geo tools, then bind the server only to the intended Agent under **Work -> Agent -> Edit -> MCP**.

References: [Cherry Studio MCP configuration](https://github.com/CherryHQ/cherry-studio-docs/blob/main/i18n/english/advanced-basic/mcp/config.md) and [MCP workflow guide](https://github.com/CherryHQ/cherry-studio-docs/blob/main/advanced-basic/extensions/mcp/README.md).

### Raycast AI

Raycast can launch local STDIO MCP servers directly. Open **Install MCP Server** (or **Manage MCP Servers -> Install New Server**), choose **Standard Input/Output**, and configure:

- Name: `digestseo`
- Command: `npx`
- Arguments: `-y` and `@digestseo/mcp-geo`

The zero-key setup is sufficient for MCP tool discovery. Before engine-backed scans, add only the selected provider keys in Raycast's MCP **Environment** key/value fields; keep secrets out of shared project files. If `npx` was added to `PATH` while Raycast was already running, restart Raycast before testing the server.

Reference: [Raycast Model Context Protocol](https://manual.raycast.com/ai/model-context-protocol).

### Msty Studio

In Msty Studio, open **Toolbox -> Add New Tool**, select **STDIO / JSON**, and enter this tool configuration:

```json
{
  "command": "npx",
  "args": ["-y", "@digestseo/mcp-geo"]
}
```

That zero-key configuration is sufficient for MCP discovery. For engine-backed scans, create only the selected provider variables in Msty Studio **Environments** and make them available to the tool instead of writing raw secrets into shared configuration. Msty Studio Desktop runs local tools directly. If using Studio Web, connect it to Studio Desktop or Sidecar first so the web app can access local MCP dependencies.

References: [Msty Studio Toolbox tools](https://docs.msty.ai/studio/toolbox/tools) and [Msty Studio environments](https://docs.msty.ai/studio/workspaces/environment).

### Jan Desktop / Jan Agent

In Jan Desktop, open **Settings -> MCP Servers -> + Add MCP Server**, choose **STDIO**, and configure:

- Command: `npx`
- Args: `-y` and `@digestseo/mcp-geo`
- Env: only the provider keys the user chose to use

That zero-key server is sufficient for MCP discovery. Jan Agent reads the same `mcp_config.json`, so the server is available in the terminal too. A headless equivalent is:

```bash
jan cli mcp add digestseo --command npx --arg -y --arg @digestseo/mcp-geo
jan cli mcp enable digestseo
```

For **Path B**, Jan also supports remote Streamable HTTP MCP servers. Add `https://<worker-host>/mcp` as an **HTTP** server and use Jan's **Sign in** action when the self-hosted Worker requests OAuth. Jan discovers the authorization metadata, uses dynamic client registration when advertised, and completes authorization code + PKCE. Keep `CONNECT_SECRET` in the Worker environment if that optional gate is enabled, and do not present the public DigestSEO endpoint as a turnkey provider-key service.

References: [Jan Desktop MCP servers](https://www.jan.ai/docs/desktop/integrations/mcp-servers), [Jan Agent MCP](https://www.jan.ai/docs/agent/mcp), and [Jan Agent CLI reference](https://www.jan.ai/docs/agent/cli).

### Zed

In Zed, open **Settings -> AI -> MCP Servers**, choose **Add Server -> Add Local Server**, and configure `digestseo` with command `npx` and arguments `-y`, `@digestseo/mcp-geo`. That zero-key local server is enough for MCP discovery. For engine-backed scans, add only the provider keys you intend to use in Zed's local MCP `env` map rather than committing secrets into shared project settings.

If the user chose **Path B** and runs their own Worker, choose **Add Remote Server** instead and use `https://<worker-host>/mcp`. With no explicit `Authorization` header, Zed follows the standard MCP OAuth flow. This remote path is for the user's own configured Worker; do not present the public DigestSEO endpoint as a turnkey provider-key service.

Reference: [Zed MCP guide](https://zed.dev/docs/ai/mcp).

### TraeCode

In TraeCode, open **Settings -> MCP -> Add -> Manually add** and paste this local STDIO configuration. For a trusted project, the same `mcpServers` object can live in `.trae/mcp.json` after project-level MCP is enabled:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

That zero-key entry is sufficient for MCP discovery. Before engine-backed scans, add only the selected provider variables through TraeCode's supported `env` map and keep raw API keys out of project-level `.trae/mcp.json`.

TraeCode CLI can also load the project's `.trae/mcp.json`. For a global CLI-only setup, run `traecli config edit`, add `digestseo` as a `stdio` server with command `npx` and args `-y`, `@digestseo/mcp-geo`, then use `/mcp` to inspect the connection and tools.

References: [TraeCode IDE MCP setup](https://docs.trae.cn/ide_add-mcp-servers) and [TraeCode CLI MCP](https://docs.trae.cn/cli_model-context-protocol).

### GitHub Copilot CLI

```bash
copilot mcp add digestseo -- npx -y @digestseo/mcp-geo
```

This zero-key base command is enough for tool discovery. Add provider keys with repeated `--env NAME=VALUE` options supported by Copilot CLI before the `digestseo -- ...` portion when engine-backed scans are needed.

### GitHub Copilot cloud agent / code review

Repository administrators can configure mcp-geo at **Settings -> Copilot -> MCP servers**. Prefer the local npm server here: Copilot cloud agent and code review currently support local/STDIO MCP servers, while remote MCP servers that require OAuth are not supported for this repository-level path.

Use an explicit read-only allowlist by default because these tools may run autonomously:

```json
{
  "mcpServers": {
    "digestseo": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"],
      "tools": [
        "check_visibility",
        "get_visibility_history",
        "compare_competitors",
        "get_citations",
        "list_brands",
        "list_prompts"
      ]
    }
  }
}
```

Those six tools publish `readOnlyHint: true`, which is required for Copilot code review to use them. They read the local mcp-geo store available in that task. If the task should create or refresh visibility data, deliberately extend the allowlist with only the required mutating tools; `refresh_brand` can make billable provider calls when engine keys are configured.

Keep provider credentials in Copilot **Agents secrets/variables** rather than repository configuration. GitHub exposes only names prefixed `COPILOT_MCP_` to repository MCP configuration. For example, after creating the secret `COPILOT_MCP_OPENAI_API_KEY`, add:

```json
"env": {
  "OPENAI_API_KEY": "$COPILOT_MCP_OPENAI_API_KEY"
}
```

Reference: [Configure MCP servers for your repository](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers).

### Portable Agent Plugin 1.0

The repository also ships the standard root `plugin.json` + `mcp.json` package for clients that implement Agent Plugins 1.0. The portable MCP entry launches the same local npm server and intentionally contains no provider secrets.

GitHub Copilot CLI can install the repository directly:

```bash
copilot plugin install AKzar1el/mcp-geo
```

VS Code: run **Chat: Install Plugin from Source** and enter `https://github.com/AKzar1el/mcp-geo`.

Kiro: open **Powers -> Add Custom Power -> Import power from GitHub** and enter `https://github.com/AKzar1el/mcp-geo`.

Zero provider keys are sufficient for plugin/MCP discovery. Before engine-backed scans, make only the selected provider keys available to the host client process; do not put secret values into the portable `mcp.json`.

References: [Agent Plugins 1.0 compatible clients](https://agent-plugins.org/compatible-clients), [GitHub Copilot plugins](https://docs.github.com/en/copilot/concepts/agents/about-plugins), and [Kiro powers installation](https://kiro.dev/docs/powers/installation/).

### Qoder CLI

```bash
qoder mcp add digestseo -- npx -y @digestseo/mcp-geo
qoder mcp list
```

Qoder CLI treats the command after `--` as a local STDIO MCP server. The zero-key form is sufficient for tool discovery. Before engine-backed scans, make only the selected provider environment variables available to the Qoder process instead of putting secret values into project configuration. If the CLI session is already open, run `/mcp reload` to rediscover the server and its tools.

References: [Qoder MCP Servers](https://docs.qoder.com/cli/mcp-servers) and [Qoder MCP reference](https://docs.qoder.com/cli/mcp-reference).

### Docker Agent

Docker Agent supports local STDIO MCP toolsets launched from `npx`. Add this block to the agent's YAML configuration:

```yaml
toolsets:
  - type: mcp
    command: npx
    args: ["-y", "@digestseo/mcp-geo"]
```

That starts mcp-geo locally and is sufficient for zero-key MCP discovery. Before engine-backed scans, add only the selected provider keys to the MCP toolset's `env:` map; Docker Agent supports `${env.NAME}` expansion, so keep the actual secret values in the process environment rather than in the YAML file.

Reference: [Docker Agent MCP tools](https://docs.docker.com/ai/docker-agent/tools/mcp/).

### goose

goose treats local MCP servers as STDIO extensions. Add mcp-geo to goose's `config.yaml` (`~/.config/goose/config.yaml` on macOS/Linux or `%APPDATA%\Block\goose\config\config.yaml` on Windows):

```yaml
extensions:
  digestseo-geo:
    type: stdio
    name: digestseo-geo
    enabled: true
    cmd: npx
    args: ["-y", "@digestseo/mcp-geo"]
    timeout: 300
```

That zero-key entry is sufficient for MCP tool discovery. For engine-backed scans, add only the provider environment variables the user chose through goose's extension configuration / secret storage; do not write raw provider API keys into `config.yaml`. The equivalent interactive flow is `goose configure` -> **Add Extension** -> **Command-Line Extension**, with command `npx -y @digestseo/mcp-geo`.

References: [goose extension setup](https://block.github.io/goose/docs/getting-started/using-extensions/) and [goose configuration files](https://block.github.io/goose/docs/guides/config-files/).

### GitLab Duo CLI

Current GitLab Duo CLI releases read Claude-compatible `.claude-plugin/marketplace.json` catalogs, so the same owner-controlled marketplace added for Claude Code works without another package or registry submission:

```bash
glab duo plugin marketplace add https://github.com/AKzar1el/mcp-geo.git
glab duo plugin install digestseo-geo@digestseo-mcp
```

The plugin loads the repository's `.mcp.json` and starts `npx -y @digestseo/mcp-geo` as a local STDIO MCP server. Zero keys still allow MCP discovery; for engine-backed scans, make only the selected provider keys available to the GitLab Duo CLI process before starting it. The equivalent `duo plugin ...` commands are also supported by the standalone Duo CLI.

### Factory Droid

```bash
droid mcp add digestseo "npx -y @digestseo/mcp-geo"
droid mcp list
```

Droid treats the quoted command as a local STDIO server and stores servers added by `droid mcp add` in the user-level `~/.factory/mcp.json`. The zero-key command is enough for MCP discovery. Before an engine-backed scan, add only the provider keys the user chose to the user-level server config; keep secrets out of project-level `.factory/mcp.json`. Droid supports `${NAME}` expansion for STDIO `env` values, so a user can reference an API key already present in their shell environment without committing the value to disk.

### Amazon Q Developer (IDE)

Open the Amazon Q Developer chat panel, select **Tools**, choose **+**, and add a **STDIO** MCP server with:

- Name: `digestseo`
- Command: `npx`
- Arguments: `-y` and `@digestseo/mcp-geo`
- Environment variables: only the provider keys the user chose to use

Amazon Q Developer supports local STDIO MCP servers and environment variables in this configuration UI. The zero-key command is enough for tool discovery; engine-backed scans still need at least one provider key.

### Amazon Q Developer CLI

Amazon Q Developer CLI has a native MCP configuration manager. Add the local mcp-geo process with:

```bash
q mcp add --name digestseo --command npx --args '["-y", "@digestseo/mcp-geo"]'
q mcp list
```

The zero-key server is enough for MCP tool discovery. Before engine-backed scans, add only the provider environment variables the user chose to the Q CLI MCP configuration instead of writing secrets into project files. Amazon Q Developer CLI supports local process-backed MCP servers; use `/tools` in a Q session to inspect the tools that loaded. AWS documents globally defined Q CLI MCP configuration under `~/.aws/amazonq/cli-agents` and the current `q mcp` management commands in its [MCP guide](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/qdev-mcp.html) and [CLI MCP configuration reference](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-config-CLI.html).

### JetBrains AI Assistant (IDE)

Open **Settings > Tools > AI Assistant > Model Context Protocol (MCP)**, choose **Add > STDIO**, and paste:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

JetBrains AI Assistant supports local STDIO MCP servers and NPX launch commands. The zero-key configuration is sufficient for MCP discovery. Before an engine-backed scan, ensure only the chosen provider API keys are present in the environment inherited by the IDE process; alternatively, JetBrains can import an existing Claude MCP configuration.

### JetBrains Junie (CLI / IDE)

Junie CLI and the Junie IDE plugin share the same MCP configuration. In Junie CLI, run `/mcp` to open the Installation Assistant; it can search the Official MCP Registry for a server, or you can add `digestseo` manually in `.junie/mcp/mcp.json` for the current project or `~/.junie/mcp/mcp.json` for the current user:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

The zero-key configuration is sufficient for MCP tool discovery. Before an engine-backed scan, expose only the selected provider API keys to the Junie process and keep raw secrets out of a project `.junie/mcp/mcp.json` that may be shared or committed. Use `/mcp` to confirm that `digestseo` is active and its tools are available.

References: [Junie CLI MCP configuration](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html) and [Junie IDE MCP settings](https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html).

### JetBrains Air

The repository already includes a standard root `.mcp.json` that starts `npx -y @digestseo/mcp-geo`, so JetBrains Air does not need a second project-specific MCP file.

1. Open **Settings > AI > MCP Servers**.
2. Turn on **Enable MCP support**.
3. Turn on **Launch workspace MCP servers** and use the **Workspace** scope.

Air then reuses the checked-in `.mcp.json` and discovers the local mcp-geo tools. That file intentionally contains no provider credentials: zero keys are enough for tool discovery, while engine-backed scans still require the selected provider keys in the local server process environment. Keep those secrets out of the committed `.mcp.json`.

Reference: [JetBrains Air MCP servers](https://www.jetbrains.com/help/air/mcp-servers.html).

### Visual Studio 2022 17.14+ / Visual Studio 2026

Visual Studio reads MCP configuration from `%USERPROFILE%\.mcp.json` for a user-wide install or `<SOLUTIONDIR>\.mcp.json` for a solution. Its schema uses `servers` rather than this repository's portable `mcpServers` root key, so create a Visual Studio-specific file with:

```json
{
  "servers": {
    "digestseo": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

Open GitHub Copilot Chat in **Agent** mode and check the **Tools** menu for `digestseo`. Zero keys are sufficient for tool discovery. For engine-backed scans, expose only the selected provider keys to the Visual Studio process instead of committing them into the solution-level `.mcp.json`.

Reference: [Microsoft's Visual Studio MCP setup](https://learn.microsoft.com/azure/developer/azure-mcp-server/get-started/tools/visual-studio).

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in the project root, same shape as Claude Desktop:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"],
      "env": {
        "OPENAI_API_KEY": "sk-REPLACE_ME"
      }
    }
  }
}
```

### Windsurf

Open Windsurf → **Manage MCPs → View raw config** and add:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"],
      "env": {
        "OPENAI_API_KEY": "sk-REPLACE_ME"
      }
    }
  }
}
```

Windsurf supports local stdio MCP servers. Keep only the provider keys the user chose; the zero-key base command still starts for tool discovery.

### VS Code

Use VS Code's MCP install URL for the local stdio package:

[Install `digestseo` in VS Code](vscode:mcp/install?%7B%22name%22%3A%22digestseo%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40digestseo%2Fmcp-geo%22%5D%7D)

The one-click link installs the zero-key base command (`npx -y @digestseo/mcp-geo`), which is enough for MCP tool discovery. Before engine-backed scans, run **MCP: Open User Configuration** and add only the provider API keys the user chose under this server's environment. Avoid hardcoding secrets in a shared workspace configuration.

### Cline

Open Cline → MCP Servers → Configure MCP Servers (this opens `cline_mcp_settings.json`) and merge:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"],
      "env": {
        "OPENAI_API_KEY": "sk-REPLACE_ME"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Roo Code

Open **MCP Servers > Edit Global MCP** for a global install, or create `.roo/mcp.json` in the project root, and add:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

This zero-key STDIO config is enough for discovery. Add only the provider environment variables the user chose before engine-backed scans. On Windows, Roo's documented fallback is `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@digestseo/mcp-geo"]` when direct `npx` launch is unavailable.

### Kiro

Open **Kiro: Open user MCP config (JSON)** for a global install, or **Kiro: Open workspace MCP config (JSON)** for a project-scoped install (`~/.kiro/settings/mcp.json` and `.kiro/settings/mcp.json` respectively), then add:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

Kiro supports local STDIO MCP servers and reconnects after the JSON config is saved. The zero-key config is enough for MCP discovery; add only the provider environment variables the user chose before engine-backed scans. For a remote deployment, Kiro also supports HTTP MCP servers via a `url` entry, but use the user's configured self-hosted Worker rather than the public `geo-mcp.digestseo.com/mcp` endpoint.

### Verify the install

Ask the client to list tools. Exactly twelve must appear: `check_visibility`, `get_visibility_history`, `compare_competitors`, `get_citations`, `get_content_gaps`, `refresh_brand`, `track_brand`, `update_brand`, `list_brands`, `list_prompts`, `set_prompts`, `generate_prompts`.

### First brand: track → refresh → check

The database starts empty. Run this three-call sequence through the MCP client (natural-language equivalent: "Track acme.com as brand `acme` and run the first scan"):

1. **`track_brand`** with arguments:

   ```json
   {
     "brand_id": "acme",
     "name": "Acme Project Tool",
     "domain": "acme.com",
     "category": "Project management software",
     "competitors": ["asana.com", "monday.com"]
   }
   ```

   Creates the brand and generates 20 buyer-intent prompts via Claude Haiku when `ANTHROPIC_API_KEY` is set; without it you get 3 generic starter prompts (`prompt_source: "fallback"`) — add the key later and call `generate_prompts` with `{"brand_id": "acme"}` to upgrade. If the brand name or domain root is an everyday word ("Monday", "Notion"), pass `exclude_terms` (and optionally `aliases`) so mentions are matched accurately.

2. **`refresh_brand`** with `{"brand_id": "acme"}` — runs every configured engine inline; progress is logged to stderr.

3. **`check_visibility`** with `{"brand_id": "acme"}` — returns the per-engine scores. `list_brands` (no arguments) recalls the `brand_id` later. `list_prompts` with that `brand_id` shows the exact active measurement set without changing it.

---

## Path B: self-host on Cloudflare Workers

The human-oriented walkthrough with full explanations and troubleshooting is [SETUP.md](./SETUP.md) — this path mirrors it in deterministic steps (≈5 minutes; requires a free Cloudflare account). The Worker MCP surface exposes the six visibility tools; brand management happens over the `X-Seed-Secret`-gated `/admin/*` routes instead of `track_brand`.

### Step 1 — Clone and install

```bash
git clone https://github.com/AKzar1el/mcp-geo.git
cd mcp-geo
npm install
```

Wrangler ships as a devDependency, so `npx wrangler` works without a global install.

### Step 2 — Authenticate wrangler

```bash
npx wrangler login
```

This opens a browser; the user completes the Cloudflare login there. One-time per machine.

### Step 3 — Create wrangler.jsonc from the template

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

(`wrangler.jsonc` is gitignored; the template stays in git.)

### Step 4 — Create the KV namespace and D1 database, paste the ids

```bash
npx wrangler kv namespace create OAUTH_KV
```

Wrangler asks three interactive questions after creating the namespace — answer them exactly (do not try to script these; the user answers in the terminal):

- "Would you like Wrangler to add it on your behalf?" → **n**
- "What binding name would you like to use?" → press **Enter** (accepts `OAUTH_KV`)
- "For local dev, do you want to connect to the remote resource instead of a local resource?" → **n**

Capture the printed `id` and replace `YOUR_OAUTH_KV_ID` in `wrangler.jsonc` with it.

```bash
npx wrangler d1 create mcp-geo-db
```

Capture the printed `database_id` and replace `YOUR_D1_DATABASE_ID` in `wrangler.jsonc` with it.

Verify nothing was missed — this must print **nothing**:

```bash
grep -E "(YOUR_OAUTH_KV_ID|YOUR_D1_DATABASE_ID)" wrangler.jsonc
```

Change **only** those two ids. Keep the `OAUTH_KV`, `DIGESTSEO_DB`, and `SELF` binding names unchanged because current runtime code references them directly. Also keep the legacy `MCP_OBJECT` binding, `GeoMcpAgent` class, and `migrations` block (tag `v1`, `new_sqlite_classes: ["GeoMcpAgent"]`) intact during the current migration hold. Current `/mcp` traffic is stateless and no longer routes through that Durable Object; removing the legacy binding/migration is a separate post-soak migration rather than an install-time rename.

**Note on the `SELF` service binding:** `"services": [{ "binding": "SELF", "service": "digestseo-mcp" }]` must keep `service` identical to the top-level `name` field. If the user renames the worker, update both. This binding is how `/admin/run-live` fans out one worker invocation per engine (a public-URL self-fetch would trip Cloudflare error 1042).

### Step 5 — Set secrets

Required (gates the `/admin/*` routes; the user should generate a high-entropy string, e.g. `openssl rand -hex 32`, and save it — it is sent later as the `X-Seed-Secret` header):

```bash
npx wrangler secret put SEED_SECRET
```

Strongly recommended (without it, anyone who discovers the worker URL can connect an MCP client and spend the user's engine API credits — see [SECURITY.md](SECURITY.md)):

```bash
npx wrangler secret put CONNECT_SECRET
```

Then set the engine keys the user has (each is opt-in; at least one required — same six as Path A):

```bash
npx wrangler secret put OPENAI_API_KEY      # ChatGPT engine — recommended starter
npx wrangler secret put ANTHROPIC_API_KEY   # Claude engine + prompt generation — recommended starter
npx wrangler secret put GEMINI_API_KEY      # optional add-on
npx wrangler secret put PERPLEXITY_API_KEY  # optional, paid
npx wrangler secret put XAI_API_KEY         # optional, paid
npx wrangler secret put SERPAPI_API_KEY     # optional
```

### Step 6 — Apply migrations and deploy

```bash
npx wrangler d1 migrations apply mcp-geo-db --remote
```

Answer **y** if asked "Would you like to apply these migrations?".

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL, e.g. `https://digestseo-mcp.<account-subdomain>.workers.dev`. **Record it** — every step below needs it.

Optional but recommended: paste that URL over the `SELF_URL` placeholder in the `"vars"` block of `wrangler.jsonc` and run `npx wrangler deploy` once more (runs work with the placeholder, but the real URL keeps logs honest).

### Step 7 — Verify the deploy

```bash
curl https://<worker-host>/healthz
```

Expected output: `ok`.

### Step 8 — Seed the user's first brand

Ask the user for their brand name, domain, category, and competitor domains, then:

```bash
curl -X POST https://<worker-host>/admin/seed \
  -H "X-Seed-Secret: <SEED_SECRET value>" \
  -H "Content-Type: application/json" \
  -d '{
    "brand_id": "acme",
    "name": "Acme Project Tool",
    "domain": "acme.com",
    "category": "Project management software",
    "competitors": ["asana.com", "monday.com"]
  }'
```

The payload also accepts optional `"aliases": [...]` and `"exclude_terms": [...]` arrays — use `exclude_terms` when the brand name or domain root is an everyday word ("Monday", "Notion").

Expected response: `{"seeded": true, "brand_id": "acme", "prompts_inserted": 20, "prompt_source": "generated"}`. If `prompt_source` is `"fallback"`, the Claude Haiku prompt generator failed — usually because `ANTHROPIC_API_KEY` is not set (transient API/network failures also trigger it). Template prompts still work; to upgrade them, set the key and re-generate via `POST /admin/generate-prompts` (same `X-Seed-Secret` header, body `{"brand_id":"acme"}`).

Before mutating prompts or triggering a scan, a self-hosted agent can inspect the tracked brand IDs and current configuration without changing state:

```bash
curl "https://<worker-host>/admin/list-brands" \
  -H "X-Seed-Secret: <SEED_SECRET value>"
```

The response returns each brand's ID, domain, category, competitors, aliases, exclusion terms, refresh frequency, active prompt count, and creation time.

To correct tracked brand metadata without losing the active prompt set or historical runs:

```bash
curl -X POST https://<worker-host>/admin/update-brand \
  -H "X-Seed-Secret: <SEED_SECRET value>" \
  -H "Content-Type: application/json" \
  -d '{"brand_id":"acme","competitors":["asana.com","linear.app"],"refresh_frequency":"daily"}'
```

Pass only the fields that need changing: `name`, `domain`, `category` (use `null` to clear it), `competitors`, `aliases`, `exclude_terms`, or `refresh_frequency`. Use `refresh_frequency: "manual"` to pause scheduled Worker cron scans while preserving the brand, prompts, and history; explicit `/admin/run-live` scans remain available, and setting `daily` or `weekly` resumes cron scheduling. The route is idempotent and future scans use the updated metadata.

If the user already has an approved audit/research measurement set, replace the active prompts exactly before scanning:

```bash
curl -X POST https://<worker-host>/admin/set-prompts \
  -H "X-Seed-Secret: <SEED_SECRET value>" \
  -H "Content-Type: application/json" \
  -d '{"brand_id":"acme","prompts":["Which project management tools are best for agencies?","Acme vs Asana for client delivery?"]}'
```

The route accepts 1-50 unique prompts, preserves historical runs, and returns `"changed": false` without rewriting the set when the submitted prompts already match.

Verify the active measurement set immediately before scanning:

```bash
curl "https://<worker-host>/admin/list-prompts?brand_id=acme" \
  -H "X-Seed-Secret: <SEED_SECRET value>"
```

This read-only admin route returns the active prompt IDs, text, metadata, and count without modifying the set.

### Step 9 — Trigger the first scan

```bash
curl -X POST https://<worker-host>/admin/run-live \
  -H "X-Seed-Secret: <SEED_SECRET value>" \
  -H "Content-Type: application/json" \
  -d '{"brand_id":"acme","wait_for_completion":true}'
```

For manual/operator scans, keep `wait_for_completion: true`. The request then stays open until the per-engine Worker invocations return, avoiding Cloudflare's 30-second post-response `waitUntil()` ceiling for long background work. A successful HTTP response means those engine invocations finished running; provider-level failures remain recorded in the run data and Worker logs. Omit the flag only when legacy asynchronous dispatch is explicitly desired, in which case wait before reading fresh data. After this, the built-in Cron Trigger (`0 */6 * * *`) checks scheduled brands every six hours. Brands set to `daily` or `weekly` auto-refresh when their cadence is due; brands set to `manual` are skipped by cron and require an explicit `/admin/run-live` scan until their cadence is changed back.

### Step 10 — Connect the MCP client

The connect URL is the Worker URL with path `/mcp`. The OAuth handshake auto-completes; if `CONNECT_SECRET` is set, a one-field browser form asks for it first.

#### Claude Code

```bash
claude mcp add --transport http digestseo https://<worker-host>/mcp
```

Then the user runs `/mcp` inside Claude Code to complete the OAuth handshake in the browser.

#### Claude.ai (web)

Settings → Connectors → Add custom connector → paste `https://<worker-host>/mcp`.

#### Perplexity Computer

On a Perplexity plan that supports custom MCP connectors, open **Account settings → Connectors → + Custom connector**, choose **Remote**, name the connector `digestseo`, and enter `https://<worker-host>/mcp`.

Choose **OAuth** for the Worker connection. Complete the browser handshake; if `CONNECT_SECRET` was configured in Step 5, enter it in the one-field gate before the OAuth flow completes. Use the user's own Worker URL rather than the public `geo-mcp.digestseo.com/mcp` endpoint, which is not a turnkey no-key fresh-scan service.

Reference: [Perplexity Computer custom MCP connectors](https://www.perplexity.ai/changelog/what-we-shipped---march-13-2026).

#### Replit Agent

Open **Integrations → MCP Servers for Replit Agent → Add MCP server**, name the server `digestseo`, and enter `https://<worker-host>/mcp`. Select **Test & Save** and use the OAuth flow when Replit detects it. Replit supports OAuth dynamic client registration (DCR); the self-hosted Worker exposes the required authorization-server discovery and `/register` endpoint, so no static provider token needs to be copied into Replit.

Complete the browser authorization step. If `CONNECT_SECRET` was configured in Step 5, enter it in the one-field gate before the connection completes. Replit Agent connects to remote HTTPS MCP servers, not this package's local stdio process, so use the user's own configured Worker and never present the public `geo-mcp.digestseo.com/mcp` endpoint as a turnkey provider-key service.

Reference: [Replit MCP](https://docs.replit.com/features/mcp/overview).

#### Claude Desktop

Merge into `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<worker-host>/mcp"]
    }
  }
}
```

#### Cursor

Same `mcp-remote` block in `~/.cursor/mcp.json`, then restart Cursor.

#### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.digestseo]
command = "npx"
args = ["-y", "mcp-remote", "https://<worker-host>/mcp"]
```

### Step 11 — Verify end to end

In the connected client, ask:

> Check the AI visibility for brand_id `acme`.

The client should call `check_visibility` and return per-engine scores for every engine whose key was set.

### Troubleshooting (Path B)

- **Tools return empty data** — no engine key set, or the first scan hasn't run. Check `npx wrangler secret list`, re-run Step 9.
- **`401 unauthorized` from `/admin/*`** — the `X-Seed-Secret` header doesn't match the deployed `SEED_SECRET`.
- **Connector won't connect** — the URL must end in `/mcp`; if `CONNECT_SECRET` is set the browser form must be completed. If OAuth loops, remove and re-add the connector.
- **Error 1042 / 404 on self-fetch** — the `services` binding's `service` value doesn't match the worker's `name` field in `wrangler.jsonc`. Fix and redeploy.
- **Gemini rows all `failed` with 429** — check the project's active Gemini API limits in Google AI Studio; limits vary by model, project, and usage tier. Wait/retry or reduce request rate first, then consider a paid tier if the project consistently needs more capacity. See [README Troubleshooting](README.md#troubleshooting) for the full list.
