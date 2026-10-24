import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readme = readFileSync('README.md', 'utf8');
const methodology = readFileSync('docs/ai-visibility-audit-methodology.md', 'utf8');
const reportPrompt = readFileSync('docs/ai-visibility-audit-report-prompt.md', 'utf8');
const setup = readFileSync('SETUP.md', 'utf8');

test('README exposes audit details and an attributable direct request path', () => {
  assert.match(
    readme,
    /\[!\[EUR 99 AI Visibility Audit\]\(https:\/\/img\.shields\.io\/badge\/AI_Visibility_Audit-EUR_99-[^)]+\)\]\(https:\/\/geo-mcp\.digestseo\.com\/audit\)/,
  );

  assert.match(
    readme,
    /\[mcp-geo AI Visibility Audit\]\(https:\/\/geo-mcp\.digestseo\.com\/audit\)/,
  );
  assert.match(
    readme,
    /mailto:info@tomiseregi\.si\?subject=mcp-geo%20AI%20Visibility%20Audit%20-%20EUR%2099&body=[^\s)]*Source%3A%20mcp-geo%20README/,
  );
  assert.match(
    readme,
    /> \*\*See proof first:\*\* \[Open the sample report\]\(https:\/\/github\.com\/AKzar1el\/mcp-geo\/blob\/main\/docs\/demo-report-full\.png\)/,
  );
  assert.match(
    readme,
    /\[reusable AI Visibility Audit report prompt\]\(https:\/\/github\.com\/AKzar1el\/mcp-geo\/blob\/main\/docs\/ai-visibility-audit-report-prompt\.md\)/,
  );
  assert.match(
    readme,
    /> \*\*Payment handoff:\*\* After fit and scope are confirmed, I reply with the normal invoice\/payment instructions\./,
  );
  assert.match(
    readme,
    /> \*\*Methodology:\*\* The same 20 buyer-intent prompts are run as a point-in-time diagnostic and reported per engine/,
  );
  assert.match(
    readme,
    /\[Read the AI Visibility Audit methodology\]\(https:\/\/github\.com\/AKzar1el\/mcp-geo\/blob\/main\/docs\/ai-visibility-audit-methodology\.md\)/,
  );
  assert.match(
    readme,
    /copilot mcp add digestseo -- npx -y @digestseo\/mcp-geo/,
  );
  assert.match(
    readme,
    /\*\*GitHub Copilot cloud agent \/ code review:\*\*[\s\S]*Settings -> Copilot -> MCP servers[\s\S]*"type": "local"[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*"check_visibility"[\s\S]*readOnlyHint: true[\s\S]*COPILOT_MCP_OPENAI_API_KEY/,
  );
  assert.match(readme, /remote MCP servers that rely on OAuth/);
  assert.match(readme, /`refresh_brand` can make billable provider calls/);
  assert.match(readme, /docs\.github\.com\/en\/copilot\/how-tos\/copilot-on-github\/customize-copilot\/configure-mcp-servers/);
  assert.match(
    readme,
    /codex mcp add digestseo -- npx -y @digestseo\/mcp-geo/,
  );
  assert.match(
    readme,
    /\*\*OpenCode v2:\*\*[\s\S]*opencode mcp add digestseo --global -- npx -y @digestseo\/mcp-geo[\s\S]*mcp\.servers\.digestseo\.environment[\s\S]*\{env:OPENAI_API_KEY\}[\s\S]*opencode mcp list[\s\S]*opencode\.ai\/v2\/docs\/mcp-servers/,
  );
  assert.match(
    readme,
    /\*\*ChatGPT \(remote MCP\):\*\*[\s\S]*does not connect directly to local STDIO MCP servers[\s\S]*self-hosted remote MCP setup/,
  );
  assert.match(
    readme,
    /\*\*Perplexity Computer \(remote MCP\):\*\*[\s\S]*Account settings > Connectors > \+ Custom connector[\s\S]*choose \*\*Remote\*\*[\s\S]*https:\/\/<worker-host>\/mcp[\s\S]*OAuth[\s\S]*CONNECT_SECRET/,
  );
  assert.match(readme, /perplexity\.ai\/changelog\/what-we-shipped---march-13-2026/);
  assert.match(
    readme,
    /\*\*Replit Agent \(remote MCP\):\*\*[\s\S]*Integrations -> MCP Servers for Replit Agent -> Add MCP server[\s\S]*https:\/\/<worker-host>\/mcp[\s\S]*OAuth dynamic client registration \(DCR\)[\s\S]*Test & Save[\s\S]*CONNECT_SECRET/,
  );
  assert.match(readme, /docs\.replit\.com\/features\/mcp\/overview/);
  assert.match(readme, /Replit supports remote HTTPS MCP servers rather than this package's local stdio process/);
  assert.doesNotMatch(readme, /ChatGPT desktop app:[\s\S]*npx -y @digestseo\/mcp-geo/);
  assert.match(
    readme,
    /#### ChatGPT \(local\/private via OpenAI Secure MCP Tunnel\)[\s\S]*tunnel-client init[\s\S]*--mcp-command "npx -y @digestseo\/mcp-geo"[\s\S]*tunnel-client doctor[\s\S]*tunnel-client run/,
  );
  assert.match(readme, /developers\.openai\.com\/api\/docs\/guides\/secure-mcp-tunnels/);
  assert.match(
    readme,
    /\*\*Windsurf:\*\*[\s\S]*"command": "npx"[\s\S]*"@digestseo\/mcp-geo"/,
  );
  assert.match(
    readme,
    /\*\*Amazon Q Developer \(IDE\):\*\*[\s\S]*choose \*\*STDIO\*\*[\s\S]*`npx`[\s\S]*`@digestseo\/mcp-geo`/,
  );
  assert.match(
    readme,
    /\*\*Amazon Q Developer CLI:\*\*[\s\S]*q mcp add --name digestseo --command npx --args '[^']*@digestseo\/mcp-geo[^']*'[\s\S]*q mcp list[\s\S]*\/tools[\s\S]*command-line-mcp-config-CLI\.html/,
  );
  assert.match(readme, /### \[0\.3\.7\] - September 19, 2026/);

  const auditCta = readme.indexOf('> **Need a client-ready baseline without running the stack yourself?**');
  const waitlistCta = readme.indexOf('> **Prefer zero setup?**');
  const auditBadge = readme.indexOf('[![EUR 99 AI Visibility Audit]');
  const quickInstall = readme.indexOf('## Quick Install');
  assert.ok(auditBadge >= 0);
  assert.ok(quickInstall >= 0);
  assert.ok(auditBadge < quickInstall, 'paid audit badge should stay in the opening badge row');
  assert.ok(auditCta >= 0);
  assert.ok(waitlistCta >= 0);
  assert.ok(auditCta < waitlistCta, 'paid audit CTA should appear before the non-revenue waitlist CTA');
});

test('README exposes independently observed MCP reliability', () => {
  assert.match(
    readme,
    /\[!\[Wellknown reliability\]\(https:\/\/wellknown\.network\/agents\/geo-tracker-by-digestseo\/badge\.svg\)\]\(https:\/\/wellknown\.network\/agents\/geo-tracker-by-digestseo\)/,
  );
});

test('README architecture reflects the stateless hosted MCP route', () => {
  assert.match(readme, /Stateless MCP handler<br\/>\(SDK v2, 6 hosted tools\)/);
  assert.match(readme, /SerpAPI<br\/>\(AI Overviews \/ AI Mode\)/);
  assert.match(
    readme,
    /current `\/mcp` traffic is served by the stateless SDK v2 handler/,
  );
  assert.doesNotMatch(
    readme,
    /W --> DO\["GeoMcpAgent<br\/>\(Durable Object, 6 MCP tools\)"\]/,
  );
});

test('self-hosted setup does not freeze fan-out guidance to an obsolete engine count', () => {
  assert.match(setup, /every selected visibility engine across the full active prompt set/);
  assert.doesNotMatch(setup, /5 engines × 20 prompts/);
});

test('published README uses durable URLs for files excluded from the npm tarball', () => {
  for (const relativeTarget of [
    './llms-install.md',
    './SECURITY.md',
    './SETUP.md',
    './CONTRIBUTING.md',
    './CHANGELOG.md',
    'docs/demo-report-full.png',
    'docs/demo-report-hero.png',
    'docs/ai-visibility-audit-methodology.md',
    'docs/ai-visibility-audit-report-prompt.md',
  ]) {
    assert.ok(!readme.includes(`](${relativeTarget})`), `README should not link to npm-excluded ${relativeTarget}`);
  }
});
test('audit methodology exposes the score formulas buyers need to verify', () => {
  assert.match(
    methodology,
    /Per-engine visibility score:[\s\S]*round\(100 \* usable prompt responses that mention the brand \/ usable prompt responses returned by that engine\)/,
  );
  assert.match(
    methodology,
    /Overall visibility score:[\s\S]*rounded arithmetic mean of the included per-engine visibility scores/,
  );
  assert.match(
    methodology,
    /Competitor share of voice:[\s\S]*that brand's mention count \/ total tracked-brand-plus-competitor mention count/,
  );
  assert.match(
    methodology,
    /Failed or skipped provider responses are excluded rather than counted as zero-visibility observations/,
  );
  assert.match(
    methodology,
    /\[Use the reusable evidence-first report prompt\]\(\.\/ai-visibility-audit-report-prompt\.md\)/,
  );
});
test('audit report prompt uses the shipped citation source summary without inventing derived metrics', () => {
  assert.match(
    reportPrompt,
    /get_citations[\s\S]*`top_sources` summary[\s\S]*recurring cited domains/,
  );
  assert.match(
    reportPrompt,
    /Domain \| Citations \| Prompts \| Engines \| Brand domain\?/,
  );
  assert.match(
    reportPrompt,
    /`citation_count`[\s\S]*`prompt_count`[\s\S]*`engines`[\s\S]*`is_brand_domain`/,
  );
  assert.match(reportPrompt, /Do not infer a citation share or source category/);
  assert.match(
    reportPrompt,
    /recurring source domains from `top_sources`, when available/,
  );
});

test('README documents Roo Code local stdio setup and Windows fallback', () => {
  assert.match(readme, /\*\*Roo Code:\*\*[\s\S]*\.roo\/mcp\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/);
  assert.match(readme, /"command": "cmd"[\s\S]*Windows fallback/);
});
test('README documents Zed local stdio and self-hosted remote OAuth setup', () => {
  assert.match(
    readme,
    /\*\*Zed:\*\*[\s\S]*Settings -> AI -> MCP Servers[\s\S]*Add Local Server[\s\S]*`npx`[\s\S]*@digestseo\/mcp-geo[\s\S]*Add Remote Server[\s\S]*https:\/\/<worker-host>\/mcp[\s\S]*standard MCP OAuth flow/,
  );
  assert.match(readme, /zed\.dev\/docs\/ai\/mcp/);
  assert.match(readme, /Do not treat the public DigestSEO endpoint as a turnkey provider-key service/);
});
test('README documents TraeCode IDE and CLI local stdio setup', () => {
  assert.match(
    readme,
    /\*\*TraeCode:\*\*[\s\S]*Settings -> MCP -> Add -> Manually add[\s\S]*\.trae\/mcp\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*traecli config edit[\s\S]*\/mcp/,
  );
  assert.match(readme, /docs\.trae\.cn\/ide_add-mcp-servers/);
  assert.match(readme, /docs\.trae\.cn\/cli_model-context-protocol/);
});

test('README documents JetBrains AI Assistant local stdio setup', () => {
  assert.match(
    readme,
    /\*\*JetBrains AI Assistant \(IDE\):\*\*[\s\S]*Model Context Protocol \(MCP\)[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
});
test('README documents JetBrains Junie local stdio setup without committed provider secrets', () => {
  assert.match(
    readme,
    /\*\*JetBrains Junie \(CLI \/ IDE\):\*\*[\s\S]*\/mcp[\s\S]*Official MCP Registry[\s\S]*\.junie\/mcp\/mcp\.json[\s\S]*~\/\.junie\/mcp\/mcp\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(readme, /keep raw secrets out of a shared or committed project `\.junie\/mcp\/mcp\.json`/);
  assert.match(readme, /junie\.jetbrains\.com\/docs\/junie-cli-mcp-configuration\.html/);
  assert.match(readme, /junie\.jetbrains\.com\/docs\/junie-plugin-mcp-settings\.html/);
});
test('README documents Amp CLI local stdio setup', () => {
  assert.match(
    readme,
    /\*\*Amp CLI:\*\*[\s\S]*amp mcp add digestseo -- npx -y @digestseo\/mcp-geo[\s\S]*ampcode\.com\/docs\/customize\/mcp/,
  );
});
test('README documents Qwen Code local stdio setup without committed provider secrets', () => {
  assert.match(
    readme,
    /\*\*Qwen Code:\*\*[\s\S]*qwen extensions install AKzar1el\/mcp-geo[\s\S]*qwen mcp add --scope user digestseo npx -y @digestseo\/mcp-geo[\s\S]*qwen mcp list[\s\S]*Agent Plugins v1[\s\S]*plugin\.json[\s\S]*mcp\.json[\s\S]*~\/\.qwen\/settings\.json[\s\S]*\.qwen\/settings\.json[\s\S]*mcpServers[\s\S]*\/mcp/,
  );
  assert.match(readme, /instead of committing raw keys to project settings/);
  assert.match(readme, /qwenlm\.github\.io\/qwen-code-docs\/en\/users\/extension\/introduction/);
  assert.match(readme, /qwenlm\.github\.io\/qwen-code-docs\/en\/users\/features\/mcp/);
});
test('README documents Augment Code and Auggie local stdio setup without committed provider secrets', () => {
  assert.match(
    readme,
    /\*\*Augment Code \/ Auggie:\*\*[\s\S]*Settings -> MCP servers[\s\S]*Import from JSON[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*auggie mcp add digestseo -- npx -y @digestseo\/mcp-geo[\s\S]*auggie mcp list[\s\S]*~\/\.augment\/settings\.json[\s\S]*\/mcp[\s\S]*MCP Tool Search/,
  );
  assert.match(readme, /Auggie's `--env NAME=VALUE` option rather than committing raw secrets/);
  assert.match(readme, /docs\.augmentcode\.com\/setup-augment\/mcp/);
  assert.match(readme, /docs\.augmentcode\.com\/cli\/integrations/);
});
test('README documents Mistral Vibe Code local stdio setup', () => {
  assert.match(
    readme,
    /\*\*Mistral Vibe Code:\*\*[\s\S]*~\/\.vibe\/config\.toml[\s\S]*\.\/\.vibe\/config\.toml[\s\S]*\[\[mcp_servers\]\][\s\S]*transport = "stdio"[\s\S]*command = "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*\/mcp digestseo/,
  );
  assert.match(readme, /docs\.mistral\.ai\/vibe\/code\/cli\/mcp-servers/);
  assert.match(readme, /docs\.mistral\.ai\/vibe\/code\/cli\/configuration/);
});
test('README documents LibreChat local stdio setup without committed provider secrets', () => {
  assert.match(
    readme,
    /\*\*LibreChat:\*\*[\s\S]*librechat\.yaml[\s\S]*mcpServers:[\s\S]*digestseo:[\s\S]*type: stdio[\s\S]*command: npx[\s\S]*@digestseo\/mcp-geo[\s\S]*Restart LibreChat/,
  );
  assert.match(readme, /librechat\.ai\/docs\/configuration\/librechat_yaml\/object_structure\/mcp_servers/);
  assert.match(readme, /rather than committing secret values into the YAML file/);
});
test('README documents AnythingLLM local stdio setup without committed provider secrets', () => {
  assert.match(
    readme,
    /\*\*AnythingLLM:\*\*[\s\S]*Agent Configuration -> MCP[\s\S]*anythingllm_mcp_servers\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*local STDIO MCP servers/,
  );
  assert.match(readme, /docs\.anythingllm\.com\/mcp-compatibility\/overview/);
  assert.match(readme, /instead of committing raw secrets/);
});
test('README documents Langflow local stdio setup without storing provider secrets in flows', () => {
  assert.match(
    readme,
    /\*\*Langflow:\*\*[\s\S]*Settings -> MCP Servers[\s\S]*Add MCP Server[\s\S]*\*\*STDIO\*\*[\s\S]*`npx`[\s\S]*@digestseo\/mcp-geo[\s\S]*MCP Tools[\s\S]*Langflow Agent/,
  );
  assert.match(readme, /MCP \*\*Environment Variables\*\* fields/);
  assert.match(readme, /Docker[\s\S]*Node\.js[\s\S]*`npx` server/);
  assert.match(readme, /docs\.langflow\.org\/mcp-client/);
});
test('README documents Flowise local Custom MCP stdio setup without implying cloud npx support', () => {
  assert.match(
    readme,
    /\*\*Flowise:\*\*[\s\S]*local\/self-hosted Flowise instance[\s\S]*\*\*Custom MCP\*\*[\s\S]*"command":"npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*Available Actions[\s\S]*twelve mcp-geo tools/,
  );
  assert.match(readme, /STDIO only when it is running locally rather than in a cloud service/);
  assert.match(readme, /docs\.flowiseai\.com\/tutorials\/tools-and-mcp/);
});
test('README documents Kilo Code local stdio setup including the Windows command wrapper', () => {
  assert.match(
    readme,
    /\*\*Kilo Code:\*\*[\s\S]*Settings -> Agent Behaviour -> MCP Servers[\s\S]*Local \(stdio\)[\s\S]*"type": "local"[\s\S]*"command": \["npx", "-y", "@digestseo\/mcp-geo"\]/,
  );
  assert.match(readme, /"command": \["cmd", "\/c", "npx", "-y", "@digestseo\/mcp-geo"\]/);
  assert.match(readme, /keep raw secrets out of project-level `kilo\.jsonc`/);
  assert.match(readme, /kilo\.ai\/docs\/automate\/mcp\/using-in-kilo-code/);
  assert.match(readme, /kilo\.ai\/docs\/automate\/mcp\/using-in-cli/);
});
test('README documents Google Antigravity local stdio setup without committed workspace secrets', () => {
  assert.match(
    readme,
    /\*\*Google Antigravity:\*\*[\s\S]*Antigravity 2\.0[\s\S]*Antigravity CLI[\s\S]*Antigravity IDE[\s\S]*View raw config[\s\S]*~\/\.gemini\/config\/mcp_config\.json[\s\S]*\.agents\/mcp_config\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(readme, /keep raw secrets out of any shared or committed copy/);
  assert.match(readme, /antigravity\.google\/docs\/mcp/);
});
test('README documents Cherry Studio local stdio and agent binding', () => {
  assert.match(
    readme,
    /\*\*Cherry Studio:\*\*[\s\S]*Settings -> MCP -> MCP Servers -> Add[\s\S]*\*\*STDIO\*\*[\s\S]*Command to `npx`[\s\S]*@digestseo\/mcp-geo[\s\S]*\*\*Tools\*\*[\s\S]*Work -> Agent -> Edit -> MCP/,
  );
  assert.match(readme, /Cherry Studio's MCP environment-variable fields/);
  assert.match(readme, /CherryHQ\/cherry-studio-docs\/blob\/main\/i18n\/english\/advanced-basic\/mcp\/config\.md/);
  assert.match(readme, /CherryHQ\/cherry-studio-docs\/blob\/main\/advanced-basic\/extensions\/mcp\/README\.md/);
});
test('README documents Raycast local stdio setup without committed provider secrets', () => {
  assert.match(
    readme,
    /\*\*Raycast AI:\*\*[\s\S]*Install MCP Server[\s\S]*Standard Input\/Output[\s\S]*`npx`[\s\S]*`-y`[\s\S]*`@digestseo\/mcp-geo`/,
  );
  assert.match(readme, /Raycast's MCP \*\*Environment\*\* fields/);
  assert.match(readme, /manual\.raycast\.com\/ai\/model-context-protocol/);
});
test('README documents Msty Studio local stdio setup without committed provider secrets', () => {
  assert.match(
    readme,
    /\*\*Msty Studio:\*\*[\s\S]*Toolbox -> Add New Tool[\s\S]*STDIO \/ JSON[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(readme, /Msty Studio \*\*Environments\*\*/);
  assert.match(readme, /docs\.msty\.ai\/studio\/toolbox\/tools/);
  assert.match(readme, /docs\.msty\.ai\/studio\/workspaces\/environment/);
});
test('README documents Jan local stdio and self-hosted remote OAuth setup', () => {
  assert.match(
    readme,
    /\*\*Jan Desktop \/ Jan Agent:\*\*[\s\S]*Settings -> MCP Servers -> \+ Add MCP Server[\s\S]*\*\*STDIO\*\*[\s\S]*`npx`[\s\S]*@digestseo\/mcp-geo[\s\S]*jan cli mcp add digestseo --command npx --arg -y --arg @digestseo\/mcp-geo[\s\S]*\*\*HTTP\*\*[\s\S]*https:\/\/<worker-host>\/mcp[\s\S]*dynamic client registration[\s\S]*PKCE/,
  );
  assert.match(readme, /jan\.ai\/docs\/desktop\/integrations\/mcp-servers/);
  assert.match(readme, /jan\.ai\/docs\/agent\/mcp/);
  assert.match(readme, /Do not present the public DigestSEO endpoint as a turnkey provider-key service/);
});
test('README documents JetBrains Air workspace MCP reuse', () => {
  assert.match(
    readme,
    /\*\*JetBrains Air:\*\*[\s\S]*standard root `\.mcp\.json`[\s\S]*Launch workspace MCP servers[\s\S]*npx -y @digestseo\/mcp-geo/,
  );
  assert.match(readme, /www\.jetbrains\.com\/help\/air\/mcp-servers\.html/);
});
test('README documents Visual Studio local stdio setup with its native schema', () => {
  assert.match(
    readme,
    /\*\*Visual Studio 2022 17\.14\+ \/ Visual Studio 2026:\*\*[\s\S]*%USERPROFILE%\\\.mcp\.json[\s\S]*"servers"[\s\S]*"type": "stdio"[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo[\s\S]*Agent[\s\S]*Tools/,
  );
  assert.match(readme, /learn\.microsoft\.com\/azure\/developer\/azure-mcp-server\/get-started\/tools\/visual-studio/);
});
test('README documents Docker Agent local stdio setup', () => {
  assert.match(
    readme,
    /\*\*Docker Agent:\*\*[\s\S]*type: mcp[\s\S]*command: npx[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(readme, /docs\.docker\.com\/ai\/docker-agent\/tools\/mcp/);
});
test('README documents goose local stdio setup without committed provider secrets', () => {
  assert.match(
    readme,
    /\*\*goose:\*\*[\s\S]*extensions:[\s\S]*type: stdio[\s\S]*cmd: npx[\s\S]*@digestseo\/mcp-geo/,
  );
  assert.match(readme, /goose configure[\s\S]*Command-Line Extension/);
  assert.match(readme, /instead of putting raw API keys in the YAML file/);
  assert.match(readme, /block\.github\.io\/goose\/docs\/getting-started\/using-extensions/);
});
test('README documents Qoder CLI local stdio setup', () => {
  assert.match(
    readme,
    /\*\*Qoder CLI:\*\*[\s\S]*qoder mcp add digestseo -- npx -y @digestseo\/mcp-geo[\s\S]*qoder mcp list[\s\S]*\/mcp reload/,
  );
  assert.match(readme, /docs\.qoder\.com\/cli\/mcp-servers/);
  assert.match(readme, /docs\.qoder\.com\/cli\/mcp-reference/);
});
test('README documents Factory Droid local stdio setup', () => {
  assert.match(readme, /\*\*Factory Droid:\*\*[\s\S]*droid mcp add digestseo "npx -y @digestseo\/mcp-geo"[\s\S]*droid mcp list/);
  assert.match(readme, /Keep provider secrets out of project-level `\.factory\/mcp\.json` files/);
});
test('README documents Kiro local stdio setup', () => {
  assert.match(
    readme,
    /\*\*Kiro:\*\*[\s\S]*kiro\.dev\/launch\/mcp\/add\?name=digestseo[\s\S]*\.kiro\/settings\/mcp\.json[\s\S]*"command": "npx"[\s\S]*@digestseo\/mcp-geo/,
  );
});
test('README keeps Gemini pricing and rate-limit guidance tied to current provider reality', () => {
  assert.match(readme, /Rate limits vary by model, project, and usage tier/);
  assert.match(readme, /check your project's active limits in AI Studio/i);
  assert.match(readme, /ai\.google\.dev\/gemini-api\/docs\/rate-limits/);
  assert.doesNotMatch(readme, /single-digit requests per minute/);
  assert.doesNotMatch(readme, /more than ~5 prompts/i);
  assert.doesNotMatch(readme, /Gemini(?:'s)? free tier rate-limits/i);
  assert.doesNotMatch(readme, /Free tier is rate-limited for brands/i);
  assert.doesNotMatch(readme, /~€0\.0001 per prompt/);
});

test('README keeps Anthropic cost guidance workload-based and linked to current pricing', () => {
  assert.match(readme, /Anthropic prices Haiku 4\.5 by input\/output tokens/);
  assert.match(readme, /platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
  assert.doesNotMatch(readme, /0\.0002 per prompt/);
  assert.doesNotMatch(readme, /Free trial credits are usually enough to evaluate/);
});

test('README describes the live Perplexity Agent API contract instead of retired Sonar pricing', () => {
  assert.match(readme, /Perplexity[^\n]*Agent API `fast` preset/);
  assert.match(readme, /docs\.perplexity\.ai\/docs\/agent-api\/quickstart/);
  assert.doesNotMatch(readme, /Perplexity Sonar engine/);
  assert.doesNotMatch(readme, /0\.005-0\.008 per prompt/);
});
