import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const guide = readFileSync('llms-install.md', 'utf8');

test('AI-agent install guide exposes the frozen managed audit alternative without displacing OSS', () => {
  assert.match(guide, /Path C \(optional\): managed AI Visibility Audit/i);
  assert.match(guide, /EUR 99 one-time/i);
  assert.match(guide, /20 buyer-intent prompts/i);
  assert.match(guide, /up to three competitors/i);
  assert.match(guide, /open-source package remains free/i);
  assert.match(
    guide,
    /mailto:info@tomiseregi\.si\?subject=mcp-geo%20AI%20Visibility%20Audit%20-%20EUR%2099&body=[^\s)]*Source%3A%20mcp-geo%20llms-install/,
  );
  assert.match(
    guide,
    /### Amazon Q Developer \(IDE\)[\s\S]*STDIO[\s\S]*Command: `npx`[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(
    guide,
    /### Amazon Q Developer CLI[\s\S]*q mcp add --name digestseo --command npx --args '[^']*@digestseo\/mcp-geo[^']*'[\s\S]*q mcp list[\s\S]*~\/\.aws\/amazonq\/cli-agents[\s\S]*command-line-mcp-config-CLI\.html/,
  );
  assert.match(
    guide,
    /### ChatGPT[\s\S]*does \*\*not\*\* connect directly to local STDIO MCP servers[\s\S]*Use \*\*Path B\*\*/,
  );
  assert.match(
    guide,
    /#### Perplexity Computer[\s\S]*Account settings → Connectors → \+ Custom connector[\s\S]*choose \*\*Remote\*\*[\s\S]*https:\/\/<worker-host>\/mcp[\s\S]*\*\*OAuth\*\*[\s\S]*CONNECT_SECRET/,
  );
  assert.match(guide, /perplexity\.ai\/changelog\/what-we-shipped---march-13-2026/);
  assert.match(
    guide,
    /#### Replit Agent[\s\S]*Integrations → MCP Servers for Replit Agent → Add MCP server[\s\S]*https:\/\/<worker-host>\/mcp[\s\S]*Test & Save[\s\S]*OAuth dynamic client registration \(DCR\)[\s\S]*CONNECT_SECRET/,
  );
  assert.match(guide, /docs\.replit\.com\/features\/mcp\/overview/);
  assert.match(guide, /Replit Agent connects to remote HTTPS MCP servers, not this package's local stdio process/);
  assert.doesNotMatch(guide, /### ChatGPT desktop app[\s\S]*npx -y @digestseo\/mcp-geo/);
  assert.match(
    guide,
    /### ChatGPT[\s\S]*tunnel-client init[\s\S]*--mcp-command "npx -y @digestseo\/mcp-geo"[\s\S]*tunnel-client doctor[\s\S]*tunnel-client run/,
  );
  assert.match(guide, /developers\.openai\.com\/api\/docs\/guides\/secure-mcp-tunnels/);
  assert.match(
    guide,
    /### Codex CLI[\s\S]*codex mcp add digestseo -- npx -y @digestseo\/mcp-geo[\s\S]*codex mcp list/,
  );
  assert.match(
    guide,
    /### GitHub Copilot cloud agent \/ code review[\s\S]*Settings -> Copilot -> MCP servers[\s\S]*"type": "local"[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*"check_visibility"[\s\S]*readOnlyHint: true[\s\S]*COPILOT_MCP_OPENAI_API_KEY/,
  );
  assert.match(guide, /remote MCP servers that require OAuth are not supported/);
  assert.match(guide, /`refresh_brand` can make billable provider calls/);
  assert.match(guide, /docs\.github\.com\/en\/copilot\/how-tos\/copilot-on-github\/customize-copilot\/configure-mcp-servers/);
  assert.match(
    guide,
    /### OpenCode v2[\s\S]*opencode mcp add digestseo --global -- npx -y @digestseo\/mcp-geo[\s\S]*mcp\.servers\.digestseo\.environment[\s\S]*\{env:OPENAI_API_KEY\}[\s\S]*opencode mcp list[\s\S]*opencode\.ai\/v2\/docs\/mcp-servers/,
  );
});

test('AI-agent guide documents Zed local stdio and self-hosted remote OAuth setup', () => {
  assert.match(
    guide,
    /### Zed[\s\S]*Settings -> AI -> MCP Servers[\s\S]*Add Local Server[\s\S]*`npx`[\s\S]*@digestseo\/mcp-geo[\s\S]*Add Remote Server[\s\S]*https:\/\/<worker-host>\/mcp[\s\S]*standard MCP OAuth flow/,
  );
  assert.match(guide, /zed\.dev\/docs\/ai\/mcp/);
  assert.match(guide, /do not present the public DigestSEO endpoint as a turnkey provider-key service/i);
});
test('AI-agent guide documents TraeCode IDE and CLI local stdio setup', () => {
  assert.match(
    guide,
    /### TraeCode[\s\S]*Settings -> MCP -> Add -> Manually add[\s\S]*\.trae\/mcp\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*traecli config edit[\s\S]*\/mcp/,
  );
  assert.match(guide, /docs\.trae\.cn\/ide_add-mcp-servers/);
  assert.match(guide, /docs\.trae\.cn\/cli_model-context-protocol/);
});

test('AI-agent guide documents JetBrains AI Assistant local stdio setup', () => {
  assert.match(
    guide,
    /### JetBrains AI Assistant \(IDE\)[\s\S]*Add > STDIO[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
});

test('AI-agent guide documents JetBrains Junie local stdio setup without committed provider secrets', () => {
  assert.match(
    guide,
    /### JetBrains Junie \(CLI \/ IDE\)[\s\S]*\/mcp[\s\S]*Official MCP Registry[\s\S]*\.junie\/mcp\/mcp\.json[\s\S]*~\/\.junie\/mcp\/mcp\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(guide, /keep raw secrets out of a project `\.junie\/mcp\/mcp\.json`/);
  assert.match(guide, /junie\.jetbrains\.com\/docs\/junie-cli-mcp-configuration\.html/);
  assert.match(guide, /junie\.jetbrains\.com\/docs\/junie-plugin-mcp-settings\.html/);
});

test('AI-agent guide distinguishes scheduled and manual Worker refresh cadences', () => {
  assert.match(
    guide,
    /Brands set to `daily` or `weekly` auto-refresh[\s\S]*brands set to `manual` are skipped by cron[\s\S]*\/admin\/run-live/,
  );
  assert.doesNotMatch(guide, /no further manual scans needed/i);
});

test('AI-agent guide describes the legacy Durable Object as a migration hold, not the active MCP route', () => {
  assert.match(
    guide,
    /keep the legacy `MCP_OBJECT` binding[\s\S]*current migration hold[\s\S]*Current `\/mcp` traffic is stateless[\s\S]*separate post-soak migration/,
  );
  assert.doesNotMatch(guide, /the code depends on these exact names/);
});

test('AI-agent guide documents Amp CLI local stdio setup', () => {
  assert.match(
    guide,
    /### Amp CLI[\s\S]*amp mcp add digestseo -- npx -y @digestseo\/mcp-geo[\s\S]*ampcode\.com\/docs\/customize\/mcp/,
  );
});
test('AI-agent guide documents Qwen Code local stdio setup without committed provider secrets', () => {
  assert.match(
    guide,
    /### Qwen Code[\s\S]*qwen extensions install AKzar1el\/mcp-geo[\s\S]*qwen mcp add --scope user digestseo npx -y @digestseo\/mcp-geo[\s\S]*qwen mcp list[\s\S]*Agent Plugins v1[\s\S]*plugin\.json[\s\S]*mcp\.json[\s\S]*~\/\.qwen\/settings\.json[\s\S]*\.qwen\/settings\.json[\s\S]*mcpServers[\s\S]*\/mcp/,
  );
  assert.match(guide, /rather than putting raw provider keys into project settings/);
  assert.match(guide, /qwenlm\.github\.io\/qwen-code-docs\/en\/users\/extension\/introduction/);
  assert.match(guide, /qwenlm\.github\.io\/qwen-code-docs\/en\/users\/features\/mcp/);
});
test('AI-agent guide documents Mistral Vibe Code local stdio setup', () => {
  assert.match(
    guide,
    /### Mistral Vibe Code[\s\S]*~\/\.vibe\/config\.toml[\s\S]*\.\/\.vibe\/config\.toml[\s\S]*\[\[mcp_servers\]\][\s\S]*transport = "stdio"[\s\S]*command = "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*\/mcp digestseo/,
  );
  assert.match(guide, /docs\.mistral\.ai\/vibe\/code\/cli\/mcp-servers/);
  assert.match(guide, /docs\.mistral\.ai\/vibe\/code\/cli\/configuration/);
});
test('AI-agent guide documents LibreChat local stdio setup without committed provider secrets', () => {
  assert.match(
    guide,
    /### LibreChat[\s\S]*librechat\.yaml[\s\S]*mcpServers:[\s\S]*digestseo:[\s\S]*type: stdio[\s\S]*command: npx[\s\S]*@digestseo\/mcp-geo[\s\S]*Restart LibreChat/,
  );
  assert.match(guide, /librechat\.ai\/docs\/configuration\/librechat_yaml\/object_structure\/mcp_servers/);
  assert.match(guide, /instead of committing raw secret values into the YAML file/);
});
test('AI-agent guide documents AnythingLLM local stdio setup without committed provider secrets', () => {
  assert.match(
    guide,
    /### AnythingLLM[\s\S]*Agent Configuration -> MCP[\s\S]*anythingllm_mcp_servers\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*STDIO is AnythingLLM's default transport/,
  );
  assert.match(guide, /docs\.anythingllm\.com\/mcp-compatibility\/overview/);
  assert.match(guide, /do not put raw API keys into shared configuration files/);
});
test('AI-agent guide documents Langflow local stdio setup without storing provider secrets in flows', () => {
  assert.match(
    guide,
    /### Langflow[\s\S]*Settings -> MCP Servers[\s\S]*Add MCP Server[\s\S]*\*\*STDIO\*\*[\s\S]*Command: `npx`[\s\S]*@digestseo\/mcp-geo[\s\S]*MCP Tools[\s\S]*Langflow Agent/,
  );
  assert.match(guide, /MCP \*\*Environment Variables\*\* fields/);
  assert.match(guide, /Docker[\s\S]*Node\.js[\s\S]*`npx` MCP server/);
  assert.match(guide, /docs\.langflow\.org\/mcp-client/);
});
test('AI-agent guide documents Flowise local Custom MCP stdio setup without implying cloud npx support', () => {
  assert.match(
    guide,
    /### Flowise[\s\S]*locally\/self-hosted[\s\S]*\*\*Custom MCP\*\*[\s\S]*"command":"npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*Available Actions[\s\S]*twelve mcp-geo tools/,
  );
  assert.match(guide, /STDIO only for local instances/);
  assert.match(guide, /docs\.flowiseai\.com\/tutorials\/tools-and-mcp/);
});
test('AI-agent guide documents Kilo Code local stdio setup including the Windows command wrapper', () => {
  assert.match(
    guide,
    /### Kilo Code[\s\S]*Settings -> Agent Behaviour -> MCP Servers[\s\S]*Local \(stdio\)[\s\S]*"type": "local"[\s\S]*"command": \["npx", "-y", "@digestseo\/mcp-geo"\]/,
  );
  assert.match(guide, /"command": \["cmd", "\/c", "npx", "-y", "@digestseo\/mcp-geo"\]/);
  assert.match(guide, /do not commit raw provider secrets into project-level `kilo\.jsonc`/);
  assert.match(guide, /kilo\.ai\/docs\/automate\/mcp\/using-in-kilo-code/);
  assert.match(guide, /kilo\.ai\/docs\/automate\/mcp\/using-in-cli/);
});
test('AI-agent guide documents Google Antigravity local stdio setup without committed workspace secrets', () => {
  assert.match(
    guide,
    /### Google Antigravity[\s\S]*Antigravity 2\.0[\s\S]*Antigravity CLI[\s\S]*Antigravity IDE[\s\S]*View raw config[\s\S]*~\/\.gemini\/config\/mcp_config\.json[\s\S]*\.agents\/mcp_config\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(guide, /Keep raw provider secrets out of a workspace `\.agents\/mcp_config\.json`/);
  assert.match(guide, /antigravity\.google\/docs\/mcp/);
});
test('AI-agent guide documents Cherry Studio local stdio and agent binding', () => {
  assert.match(
    guide,
    /### Cherry Studio[\s\S]*Settings -> MCP -> MCP Servers -> Add[\s\S]*\*\*STDIO\*\*[\s\S]*Command: `npx`[\s\S]*@digestseo\/mcp-geo[\s\S]*twelve mcp-geo tools[\s\S]*Work -> Agent -> Edit -> MCP/,
  );
  assert.match(guide, /Cherry Studio's MCP environment-variable fields/);
  assert.match(guide, /CherryHQ\/cherry-studio-docs\/blob\/main\/i18n\/english\/advanced-basic\/mcp\/config\.md/);
  assert.match(guide, /CherryHQ\/cherry-studio-docs\/blob\/main\/advanced-basic\/extensions\/mcp\/README\.md/);
});
test('AI-agent guide documents Raycast local stdio setup without committed provider secrets', () => {
  assert.match(
    guide,
    /### Raycast AI[\s\S]*Install MCP Server[\s\S]*Standard Input\/Output[\s\S]*Command: `npx`[\s\S]*Arguments: `-y` and `@digestseo\/mcp-geo`/,
  );
  assert.match(guide, /MCP \*\*Environment\*\* key\/value fields/);
  assert.match(guide, /manual\.raycast\.com\/ai\/model-context-protocol/);
});
test('AI-agent guide documents Msty Studio local stdio setup without committed provider secrets', () => {
  assert.match(
    guide,
    /### Msty Studio[\s\S]*Toolbox -> Add New Tool[\s\S]*STDIO \/ JSON[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(guide, /Msty Studio \*\*Environments\*\*/);
  assert.match(guide, /docs\.msty\.ai\/studio\/toolbox\/tools/);
  assert.match(guide, /docs\.msty\.ai\/studio\/workspaces\/environment/);
});
test('AI-agent guide documents Jan local stdio and self-hosted remote OAuth setup', () => {
  assert.match(
    guide,
    /### Jan Desktop \/ Jan Agent[\s\S]*Settings -> MCP Servers -> \+ Add MCP Server[\s\S]*Command: `npx`[\s\S]*@digestseo\/mcp-geo[\s\S]*jan cli mcp add digestseo --command npx --arg -y --arg @digestseo\/mcp-geo[\s\S]*jan cli mcp enable digestseo[\s\S]*Streamable HTTP[\s\S]*https:\/\/<worker-host>\/mcp[\s\S]*dynamic client registration[\s\S]*PKCE/,
  );
  assert.match(guide, /jan\.ai\/docs\/desktop\/integrations\/mcp-servers/);
  assert.match(guide, /jan\.ai\/docs\/agent\/mcp/);
  assert.match(guide, /jan\.ai\/docs\/agent\/cli/);
  assert.match(guide, /do not present the public DigestSEO endpoint as a turnkey provider-key service/i);
});
test('AI-agent guide documents JetBrains Air workspace MCP reuse', () => {
  assert.match(
    guide,
    /### JetBrains Air[\s\S]*standard root `\.mcp\.json`[\s\S]*Launch workspace MCP servers[\s\S]*npx -y @digestseo\/mcp-geo/,
  );
  assert.match(guide, /www\.jetbrains\.com\/help\/air\/mcp-servers\.html/);
});
test('AI-agent guide documents Visual Studio local stdio setup with its native schema', () => {
  assert.match(
    guide,
    /### Visual Studio 2022 17\.14\+ \/ Visual Studio 2026[\s\S]*%USERPROFILE%\\\.mcp\.json[\s\S]*"servers"[\s\S]*"type": "stdio"[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*Agent[\s\S]*Tools/,
  );
  assert.match(guide, /learn\.microsoft\.com\/azure\/developer\/azure-mcp-server\/get-started\/tools\/visual-studio/);
});
test('AI-agent guide documents Docker Agent local stdio setup', () => {
  assert.match(
    guide,
    /### Docker Agent[\s\S]*type: mcp[\s\S]*command: npx[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(guide, /docs\.docker\.com\/ai\/docker-agent\/tools\/mcp/);
});
test('AI-agent guide documents goose local stdio setup', () => {
  assert.match(
    guide,
    /### goose[\s\S]*extensions:[\s\S]*type: stdio[\s\S]*cmd: npx[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(guide, /goose configure[\s\S]*Command-Line Extension/);
  assert.match(guide, /do not write raw provider API keys into `config\.yaml`/);
  assert.match(guide, /block\.github\.io\/goose\/docs\/guides\/config-files/);
});
test('AI-agent guide documents Qoder CLI local stdio setup', () => {
  assert.match(
    guide,
    /### Qoder CLI[\s\S]*qoder mcp add digestseo -- npx -y @digestseo\/mcp-geo[\s\S]*qoder mcp list[\s\S]*\/mcp reload/,
  );
  assert.match(guide, /docs\.qoder\.com\/cli\/mcp-servers/);
  assert.match(guide, /docs\.qoder\.com\/cli\/mcp-reference/);
});
test('AI-agent guide documents Factory Droid local stdio setup', () => {
  assert.match(guide, /### Factory Droid[\s\S]*droid mcp add digestseo "npx -y @digestseo\/mcp-geo"[\s\S]*droid mcp list/);
  assert.match(guide, /~\/\.factory\/mcp\.json/);
  assert.match(guide, /keep secrets out of project-level `\.factory\/mcp\.json`/i);
});
test('AI-agent guide documents Roo Code global and project stdio setup', () => {
  assert.match(guide, /### Roo Code[\s\S]*Edit Global MCP[\s\S]*\.roo\/mcp\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/);
  assert.match(guide, /Roo's documented fallback[\s\S]*"command": "cmd"/);
});
test('AI-agent guide documents Kiro user and workspace stdio setup', () => {
  assert.match(
    guide,
    /### Kiro[\s\S]*~\/\.kiro\/settings\/mcp\.json[\s\S]*\.kiro\/settings\/mcp\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
});
test('AI-agent guide does not hard-code Gemini quota assumptions', () => {
  assert.match(guide, /active Gemini API limits in Google AI Studio/);
  assert.match(guide, /limits vary by model, project, and usage tier/);
  assert.doesNotMatch(guide, /Gemini free-tier rate limit; drop the key or upgrade/);
  assert.doesNotMatch(guide, /more than ~5 prompts/i);
  assert.doesNotMatch(guide, /Free tier rate-limits brands/i);
});

test('AI-agent guide describes Perplexity through the Agent API fast preset', () => {
  assert.match(guide, /PERPLEXITY_API_KEY[^\n]*Agent API `fast` preset/);
  assert.match(guide, /docs\.perplexity\.ai\/docs\/agent-api\/quickstart/);
  assert.doesNotMatch(guide, /Perplexity — Sonar engine/);
});
