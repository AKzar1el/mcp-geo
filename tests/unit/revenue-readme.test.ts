import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readme = readFileSync('README.md', 'utf8');
const methodology = readFileSync('docs/ai-visibility-audit-methodology.md', 'utf8');

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
    /> \*\*See proof first:\*\* \[Open the sample report\]\(docs\/demo-report-full\.png\)/,
  );
  assert.match(
    readme,
    /\[reusable AI Visibility Audit report prompt\]\(docs\/ai-visibility-audit-report-prompt\.md\)/,
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
    /\[Read the AI Visibility Audit methodology\]\(docs\/ai-visibility-audit-methodology\.md\)/,
  );
  assert.match(
    readme,
    /copilot mcp add digestseo -- npx -y @digestseo\/mcp-geo/,
  );
  assert.match(
    readme,
    /\*\*ChatGPT desktop app:\*\*[\s\S]*Settings → MCP servers → Add server[\s\S]*npx -y @digestseo\/mcp-geo/,
  );
  assert.match(
    readme,
    /\*\*Windsurf:\*\*[\s\S]*"command": "npx"[\s\S]*"@digestseo\/mcp-geo"/,
  );
  assert.match(
    readme,
    /\*\*Amazon Q Developer \(IDE\):\*\*[\s\S]*choose \*\*STDIO\*\*[\s\S]*`npx`[\s\S]*`@digestseo\/mcp-geo`/,
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
