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
- Where local `list_prompts` is available, inspect its `prompt_review` warning for missing category or brand-named questions before any authorized provider-backed refresh. Verify the actual prompt wording and count; an advisory is not proof of representativeness. Hosted clients without this tool must obtain prompt-set evidence through their authorized admin workflow, not assume that 20 prompts were configured.
- If a fresh provider run is not authorized, use the latest completed usable data and say that explicitly.
- Never invent missing citations, provider results, competitor mentions, or recommendations.
- Failed or skipped provider responses are unavailable observations, not zero-visibility observations.
- If an engine has no usable responses, list it as unavailable rather than filling in a score.
- Use `get_content_gaps.observation_coverage` to distinguish actually observed prompts and engines from attempted or missing measurements; a completed scan with zero usable active-prompt responses is unmeasured, not evidence of zero visibility.
- For a current buyer-question baseline, select the active cohort consistently: `check_visibility(active_prompts_only=true, engines=[...])`, `compare_competitors(active_prompts_only=true, engines=[...])`, `get_content_gaps(engines=[...])` and `get_citations(active_prompts_only=true, current_identity_only=true, engines=[...])` with the same selected audit surfaces. For a justified trend, use `get_visibility_history(active_prompts_only=true, current_identity_only=true, engines=[...])` with those surfaces, and inspect `prompt_set_comparability.current_active_roster` before claiming comparable measurements. The overall score must describe only the selected audit engines; omit `engines` only when deliberately reporting all stored surfaces.
- Historical defaults may include retired prompts. Label any historical default result separately; never combine its scores, competitor shares or source counts with current-cohort figures as if they shared a denominator.
- Use the same time window (`days`) for competitor comparisons and citations when practical. Disclose different time windows, scan timestamps and any latest-snapshot versus full-window differences rather than silently presenting them as one synchronized sample.
- Active-only and current-identity selectors filter stored evidence; they do not perform a fresh scan or make new provider requests. If the current prompt cohort has no usable observations for an engine, describe it as unmeasured, not zero visibility. A missing recorded identity boundary also cannot establish that old evidence belongs to today's brand.
- Treat all results as a point-in-time diagnostic, not a ranking guarantee or forecast.

Use these mcp-geo capabilities (or their hosted visibility.* aliases):
0. list_prompts on local installations, when available, to review the measurement questions before a fresh scan; the hosted remote MCP surface does not expose this local brand-management tool.
1. check_visibility(active_prompts_only=true, engines=[...]) for the latest usable current-question per-engine and overall visibility snapshot across the selected audit engines. Omit or pass [] only for an explicitly all-surface report.
2. compare_competitors(active_prompts_only=true, engines=[...]) for selected-surface, current-question competitor share of voice and winning/losing prompts. Passing an empty engine list keeps all stored engines; only use that for an explicitly all-surface comparison.
3. get_citations(active_prompts_only=true, current_identity_only=true, engines=[...]) for current-question and attributable-identity source evidence on only the selected audit engines. Use its `top_sources` summary to identify recurring cited domains across the selected window, then use individual citation rows for concrete examples. Check `engine_scope` and whether `identity_filter.applied` is true; a missing identity boundary leaves historical attribution uncertain.
4. get_content_gaps(engines=[...]) for recommendations grounded in losing prompts on the selected audit surfaces. Omitted or empty engines uses the historical all-engine default.
5. get_visibility_history(active_prompts_only=true, current_identity_only=true, engines=[...]) only when a time comparison is explicitly relevant and comparable usable history exists. Use the same selected audit engines as the current snapshot; retired-only history is unmeasured under this selector, not a zero score.
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
- If `check_visibility.freshness` reports that `mixed_age_warning` is true, identify its older engines using `older_engines` and state that the combined score is not from one synchronized scan.
- From the `observation_coverage` field of `get_content_gaps`, state the `active_prompt_count` denominator and use `per_engine` to report actual usable/missing prompt evidence within its selected engine scope. Include each measured engine's `refreshed_at` date, then distinguish `incomplete_engines` from `unmeasured_engines`; do not describe a sparse or all-error run as a complete audit. Read `engine_scope` for the requested engines, and distinguish missing latest eligible runs from runs whose evidence was excluded by identity or active-prompt filters. Do not count unselected surfaces as measured or unmeasured.
- Read `get_content_gaps`'s `configuration_comparability`: when `historical_settings_warning` is true, name `engines_scanned_before_update` and explain that their evidence predates the latest tracked-brand settings edit. This can include a cadence-only change; do not assume the brand identity changed or reinterpret historical scores as current.
- Inspect `check_visibility.identity_attribution` and `get_content_gaps.identity_attribution`: scans before a recorded name/domain/alias/exclusion change are excluded from current-identity scoring and recommendations. List stale engines and missing post-change evidence, not stale scores as current measurements. Historical observations remain valid only for their original identity; legacy changes before the boundary was recorded may be unknown.
- If `google_search_sampling` is present for usable Google AI Overviews/AI Mode observations, disclose the US/English sample boundary (`gl=us`, `hl=en`): it does not represent other markets or languages. Include this disclosure even if there were no competitor-only losses; if the field is absent, do not invent Google coverage.
- Disclose any missing prompt-set evidence instead of presenting the active sample as independently verified.
- State `prompt_set_scope.selection` for check_visibility, compare_competitors, get_citations and get_visibility_history when used. If an output is full-history, report it as separate historical context, not part of the current-question denominator. Inspect the comparison and citation `engine_scope` fields: cited domains from unselected engines must not enter the scoped report, and selected engines without successful citation-source observations remain unmeasured, not zero. For citations inspect `identity_filter.applied`; for history inspect `identity_scope`, `prompt_set_comparability` and the current active roster before asserting like-for-like change.
- In scoped history, list `engine_scope.not_observed_engines` as explicitly requested surfaces without stored observations in the window, and `measurement_scope.unmeasured_scoped_engines` as surfaces with past observations but no usable evidence under the selected identity and buyer-question filters. Neither is zero visibility or proof a provider was configured or scanned. Do not mix unselected engines into the scoped trend; filtering stored history never triggers a provider refresh.
- For a separate like-for-like search-requested trend, pass `measurement_mode='search_requested'` to `get_visibility_history` with the same selected engines, active-question and identity selectors. Its trend and roster evidence exclude model-only runs; use `measurement_scope.measurement_mode_filter`, `excluded_mode_runs` and `unmeasured_scoped_engines` to disclose the smaller selected sample. The default keeps both modes, and a mode-limited trend must not be compared directly with an all-mode headline visibility score. Search-requested alone does not prove sources were returned.
- In engine-scoped competitor comparison, list `engine_scope.not_observed_engines` where requested engines lack successful stored responses, and `engine_scope.unmeasured_scoped_engines` where recorded responses were excluded by identity or active-buyer-question filters. Neither is measured zero visibility; no new scan is implied.
- Report the selected comparison/citation `days` window and the latest per-engine snapshot timestamps. Flag any different time windows, mixed-age measurements or missing active-question coverage.
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
Domain | Citations | Prompts | Engines | Evidence modes | Brand domain?

Use the reported `citation_count`, `prompt_count`, `engines`, `measurement_modes`, and `is_brand_domain` values as returned. Disclose model-only versus search-requested evidence for each recurring source. For a separate search-requested-only evidence view, call `get_citations(measurement_mode='search_requested')` with the same selected engines, identity, active-prompt and time-window filters, and label its smaller denominator rather than mixing it with the full-window summary. The default remains unfiltered; neither request mode alone verifies that a source was actually cited. Do not infer a citation share or source category that mcp-geo did not report.

List the strongest concrete citation examples returned by the engines:
Prompt | Engine | Source/domain | What the evidence shows

If citation evidence is sparse or unavailable, say so directly.

## 6. Content gaps
Summarize the grounded recommendations from get_content_gaps scoped to the same selected audit engines as the comparison and trend. Tie each recommendation to the observed losing prompts, competitor appearances, or citation/source evidence that supports it.
Read `get_content_gaps` and its `measurement_scope` field: distinguish model-only observations from search-requested observations in the supporting evidence. Either mode alone is not proof of source citations; only show provider-returned source links as citation evidence and do not imply a live web search from a model-only answer.
Use `losing_prompt_evidence` to locate the stored prompt/run/`response_id` records behind competitor-only losses. These record IDs are not verified source citations: inspect stored responses before quoting any model answer, and never substitute a response ID for a provider-returned citation URL. If observations are sparse, qualify the recommendation rather than inventing stronger evidence.

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
- Per-engine `observation_coverage` freshness and missing-prompt limits, with unavailable engines identified explicitly.
- Any configuration-comparability or Google sampling limitation that affects interpretation.
- Relevant stored losing-prompt response references, if reviewed; label them as internal observation receipts, not external source citations.
- Any engines or observations excluded because they failed or were unavailable.
- The most decision-relevant recurring source domains from `top_sources`, when available.
- The most decision-relevant citation/source examples.
- A short note explaining that the report is a bounded snapshot.

Keep the language plain, client-ready, and evidence-first. Prefer concrete observed examples over generic GEO advice.
```

## Tool-name mapping

Local stdio names:

- `list_prompts` (local brand management only; not exposed by the hosted MCP aliases)
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
