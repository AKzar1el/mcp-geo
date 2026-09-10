import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readme = readFileSync('README.md', 'utf8');

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
