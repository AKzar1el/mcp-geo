# mcp-geo Monetization Experiment

## Experiment contract

- Start date: 2026-09-10 (Europe/Ljubljana)
- Starting main SHA: `f48c265fdac3e8aa5881564b9b10b2158e0bec71`
- Fixed end: 2026-09-17 04:05 Europe/Ljubljana
- Status: RUNNING
- Revenue status: UNVERIFIED

## Frozen hypothesis

Sell a fixed-price **EUR 99 one-time AI Visibility Audit** to indie SaaS founders and small marketing/SEO teams that want a credible multi-engine GEO baseline and prioritized next actions without subscribing to another recurring dashboard or operating mcp-geo themselves.

The free/open-source mcp-geo product remains unchanged in availability and capability. The paid value is the human-operated setup, execution, interpretation, and concise client-ready result.

## Frozen target paying user

A founder, marketer, or small SEO/GEO team responsible for one active brand who wants to answer: where does the brand appear in AI answers, which competitors win the same buyer-intent prompts, what sources/citations appear, and what should be addressed first?

## Frozen offer and value exchange

**mcp-geo AI Visibility Audit - EUR 99 one time**

Scope:

- one brand/domain;
- up to three named competitors;
- 20 buyer-intent prompts generated or agreed for the brand/category;
- checks across up to five mcp-geo-supported AI surfaces where the configured providers return usable results;
- brand visibility/share-of-voice comparison;
- citation/source evidence where returned by the engines;
- prioritized content-gap/action memo grounded in the observed prompt results;
- concise delivered report;
- target delivery within two business days after usable brand/competitor input is received.

No ranking improvement, citation gain, traffic increase, or commercial outcome is guaranteed.

## Monetization/payment path

Public request path: `info@tomiseregi.si` with an mcp-geo audit request. The buyer receives normal invoice/payment instructions after fit and scope are confirmed. A request, invoice, or promise does **not** count as revenue; only independently verified money actually received/earned counts.

GitHub Sponsors is not part of the frozen offer and must not be treated as active unless its public profile/payment capability is independently verified.

## Evidence for the choice

Retrieved 2026-09-10 unless otherwise stated.

1. mcp-geo already implements the required measurement primitives: AI visibility snapshots, competitor comparison, citation evidence, content-gap recommendations, and up to five supported AI engines. Its README also shows an example strategist-style report and a public hosted endpoint. Source: https://github.com/AKzar1el/mcp-geo
2. The repository currently has 44 GitHub stars, indicating some existing public interest without implying paying demand. Source: https://api.github.com/repos/AKzar1el/mcp-geo
3. Peec AI's official pricing positions recurring AI-search visibility software at a materially higher recurring spend: its current Starter plan includes 50 prompts, 3 models, and one project; its published AI instructions list the Starter price as USD 95/month. Sources: https://peec.ai/pricing and https://peec.ai/ai-instructions
4. A current GEO audit provider sells a directly comparable one-time diagnostic from USD 99, including prompt-level visibility testing, competitor share-of-voice, and quick-win actions. Source: https://generativeengineoptimization.solutions/geo-audit/
5. GenSight publishes a USD 99 one-time AI visibility audit alongside higher recurring subscriptions, supporting a one-off diagnostic as a real category purchase pattern. Source: https://gensight.ai/
6. Recent public buyer/community discussions show both demand for actionable AI-visibility insight and resistance to expensive recurring tool stacks. Examples: https://www.reddit.com/r/SEO_for_AI/comments/1vq9raq/looking_for_the_best_basic_ai_seo_tool/ and https://www.reddit.com/r/b2bmarketing/comments/1sm9qcd/what_is_the_best_free_ai_visibility_tool/
7. Recent community discussion also criticizes AI-visibility tools that provide inconsistent scores or dashboards without clear causal/actionable interpretation. This favors selling a bounded interpreted diagnostic rather than another dashboard subscription. Example: https://www.reddit.com/r/SEO_tools_reviews/comments/1t683c8/removed/

## Why this hypothesis won

Compared with sponsorship-only, a paid hosted SaaS tier, affiliate monetization, and a custom consulting retainer, the fixed-price audit has the shortest credible path to a monetary event within seven days while reusing capabilities already shipped in mcp-geo. It requires no new billing platform, no new external account, no unrelated repository, no recurring service architecture, and no degradation of the OSS product.

The EUR 99 price is intentionally aligned with current one-time category audits rather than invented from internal cost. It is high enough to represent a real purchase but low enough to be a bounded diagnostic rather than a consulting engagement.

## Success and failure

**SUCCESS:** at least one independently verifiable, attributable monetary event greater than EUR 0 caused by this frozen mcp-geo audit offer before the fixed end time.

**FAIL:** no such verified monetary event by 2026-09-17 04:05 Europe/Ljubljana.

**UNVERIFIED:** credible evidence suggests a payment may have occurred, but independent confirmation is unavailable by the fixed end time.

## Diagnostic metrics that do not count as success

- GitHub stars/forks/watchers;
- README/audit-page visits if observable without adding hidden telemetry;
- clicks;
- emails or audit inquiries;
- invoices issued;
- waitlist joins;
- repository traffic;
- report requests;
- verbal/written intent to buy;
- projected or pipeline revenue.

## Frozen fields

The following may not change during this experiment:

- monetization hypothesis: fixed-price one-time AI Visibility Audit;
- target paying user: indie SaaS founders and small marketing/SEO teams responsible for one active brand;
- offer category/value exchange: EUR 99 for setup/execution/interpretation of a bounded mcp-geo audit, with the OSS product remaining free;
- success criterion;
- failure criterion;
- fixed end date/time.

Implementation details, exact wording, placement, and reliability fixes may change only when evidence supports them and only within this frozen offer.

## Operational log

### 2026-09-10

- PR #25 merged the frozen experiment contract and tested `/audit` Worker surface into `main`; main CI passed.
- A production Wrangler dry-run against the existing `digestseo-mcp` topology passed with the expected D1, KV, Durable Object, service, and `SELF_URL` bindings.
- The real deploy was rejected before a new Worker version was created because the machine's current `CLOUDFLARE_API_TOKEN` lacks `Workers Scripts Write`. The previous production version remains the last-known-good deployment.
- Because `https://geo-mcp.digestseo.com/audit` therefore remains undeployed, the public README audit CTA was changed to the already-frozen direct `mailto:info@tomiseregi.si` request path instead of leaving a broken conversion link. This is an implementation fallback inside the same frozen EUR 99 audit hypothesis, not a pivot.
