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
    /### ChatGPT[\s\S]*does \*\*not\*\* connect directly to local STDIO MCP servers[\s\S]*Use \*\*Path B\*\*/,
  );
  assert.match(
    guide,
    /#### Perplexity Computer[\s\S]*Account settings → Connectors → \+ Custom connector[\s\S]*choose \*\*Remote\*\*[\s\S]*https:\/\/<worker-host>\/mcp[\s\S]*\*\*OAuth\*\*[\s\S]*CONNECT_SECRET/,
  );
  assert.match(guide, /perplexity\.ai\/changelog\/what-we-shipped---march-13-2026/);
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
    /### OpenCode v2[\s\S]*opencode mcp add digestseo --global -- npx -y @digestseo\/mcp-geo[\s\S]*mcp\.servers\.digestseo\.environment[\s\S]*\{env:OPENAI_API_KEY\}[\s\S]*opencode mcp list[\s\S]*opencode\.ai\/v2\/docs\/mcp-servers/,
  );
});

test('AI-agent guide documents JetBrains AI Assistant local stdio setup', () => {
  assert.match(
    guide,
    /### JetBrains AI Assistant \(IDE\)[\s\S]*Add > STDIO[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
});
test('AI-agent guide documents Amp CLI local stdio setup', () => {
  assert.match(
    guide,
    /### Amp CLI[\s\S]*amp mcp add digestseo -- npx -y @digestseo\/mcp-geo[\s\S]*ampcode\.com\/docs\/customize\/mcp/,
  );
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
test('AI-agent guide documents Raycast local stdio setup without committed provider secrets', () => {
  assert.match(
    guide,
    /### Raycast AI[\s\S]*Install MCP Server[\s\S]*Standard Input\/Output[\s\S]*Command: `npx`[\s\S]*Arguments: `-y` and `@digestseo\/mcp-geo`/,
  );
  assert.match(guide, /MCP \*\*Environment\*\* key\/value fields/);
  assert.match(guide, /manual\.raycast\.com\/ai\/model-context-protocol/);
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
