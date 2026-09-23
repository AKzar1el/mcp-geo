# AI Visibility Audit Report Prompt

Use this prompt with an MCP client connected to mcp-geo when you want a consistent, client-ready report from the existing visibility, competitor, citation, and content-gap tools.

This does **not** change the audit scope, scoring, provider coverage, or pricing. For the managed EUR 99 audit, provider-backed refreshes should only be run after the buyer inputs are usable and the run is authorized. DIY users should review their own provider costs before refreshing.

## Copy-paste prompt

```text
Prepare a client-ready AI Visibility Audit for brand ID [BRAND_ID].

Scope and evidence rules:
- Use the existing mcp-geo data and tools only.
- The managed audit scope is one brand/domain, up to three named competitors, 20 buyer-intent prompts, and up to five supported AI surfaces where configured providers return usable results.
- If this is an authorized fresh audit run, confirm the active prompt set is exactly 20 before refreshing. If it is not exactly 20, stop and report the mismatch instead of silently continuing.
- If a fresh provider run is not authorized, use the latest completed usable data and say that explicitly.
- Never invent missing citations, provider results, competitor mentions, or recommendations.
- Failed or skipped provider responses are unavailable observations, not zero-visibility observations.
- If an engine has no usable responses, list it as unavailable rather than filling in a score.
- Treat all results as a point-in-time diagnostic, not a ranking guarantee or forecast.

Use these mcp-geo capabilities (or their hosted visibility.* aliases):
1. check_visibility for the current per-engine and overall visibility snapshot.
2. compare_competitors for observed competitor share of voice and winning/losing prompts.
3. get_citations for source/citation evidence where returned. Use its `top_sources` summary to identify recurring cited domains across the tracked prompt window, then use the individual citation rows for concrete examples.
4. get_content_gaps for recommendations grounded in losing prompts.
5. get_visibility_history only when a time comparison is explicitly relevant and comparable usable history exists.
6. refresh_brand only when a fresh provider-backed run is authorized.

Produce the report in this order:

# AI Visibility Audit — [BRAND]

## 1. Executive summary
- 3-5 concise bullets covering current visibility, strongest/weakest engines, the most important competitor gap, and the highest-priority action.
- State how many supported engines returned usable observations.

## 2. Audit scope and limitations
- Brand/domain.
- Named competitors.
- Prompt count used.
- Engines with usable data and engines unavailable for this run.
- Observation timestamp or latest usable run timestamp.
- One sentence that AI answers vary by model, interface, geography, provider behavior, time, and prompt wording.

## 3. Visibility by engine
Create a compact table:
Engine | Usable prompts | Brand mentions | Visibility score | Key observation

Use mcp-geo's reported scoring. Do not recalculate failed/skipped responses as misses.

## 4. Competitor share of voice
Create a compact table:
Brand/competitor | Observed mentions | Share of voice

Use `your_mentions` for the tracked brand and each competitor's `mentions` value from `compare_competitors`; do not infer counts from rounded percentages. Then identify the 3 most important winning or losing prompt patterns. Do not imply exclusivity when a response mentions multiple brands.

## 5. Citation/source evidence
Start with the recurring source landscape from `top_sources` when it is available:
Domain | Citations | Prompts | Engines | Brand domain?

Use the reported `citation_count`, `prompt_count`, `engines`, and `is_brand_domain` values as returned. Do not infer a citation share or source category that mcp-geo did not report.

List the strongest concrete citation examples returned by the engines:
Prompt | Engine | Source/domain | What the evidence shows

If citation evidence is sparse or unavailable, say so directly.

## 6. Content gaps
Summarize the grounded recommendations from get_content_gaps. Tie each recommendation to the observed losing prompts, competitor appearances, or citation/source evidence that supports it.

## 7. Prioritized action memo
Give exactly three prioritized actions:
1. Highest expected leverage.
2. Second priority.
3. Third priority.

For each action include:
- Evidence from this audit.
- What to change or create.
- Why it may improve the brand's eligibility to be mentioned/cited.
- A measurable follow-up check.

Do not promise rankings, citations, traffic, leads, or revenue.

## 8. Evidence appendix
Include:
- The prompt count used.
- Per-engine usable response counts.
- Any engines or observations excluded because they failed or were unavailable.
- The most decision-relevant recurring source domains from `top_sources`, when available.
- The most decision-relevant citation/source examples.
- A short note explaining that the report is a bounded snapshot.

Keep the language plain, client-ready, and evidence-first. Prefer concrete observed examples over generic GEO advice.
```

## Tool-name mapping

Local stdio names:

- `check_visibility`
- `get_visibility_history`
- `compare_competitors`
- `get_citations`
- `get_content_gaps`
- `refresh_brand`

Hosted Worker aliases:

- `visibility.check`
- `visibility.history`
- `visibility.compare`
- `visibility.citations`
- `visibility.content_gaps`
- `visibility.refresh`

For the exact score definitions and interpretation limits, see [AI Visibility Audit Methodology](./ai-visibility-audit-methodology.md).
