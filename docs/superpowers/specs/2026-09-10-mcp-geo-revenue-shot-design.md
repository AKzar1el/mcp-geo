# mcp-geo Revenue Shot Design

## Status

Approved by the user through the explicit autonomous-monetization mission contract in the invoking prompt.

## Objective

Produce at least one real, attributable monetary event greater than EUR 0 within the fixed experiment window, while preserving mcp-geo as a useful free/open-source product. Engagement, stars, clicks, leads, promises, and projected revenue are diagnostics only.

## Scope

- Target repository: `AKzar1el/mcp-geo` only.
- Production surface: existing Cloudflare Worker `digestseo-mcp` at `https://geo-mcp.digestseo.com` only.
- Public research may be broad; mutations may not cross the target-repository boundary.
- No paid ads, cold outreach, spam, new financial accounts, external contract acceptance, deceptive claims, hidden telemetry, or degradation of the free OSS product.

## Orchestration

The hourly scheduler is a wake source, not a retry loop. A temporary control branch, `experiment/revenue-shot-control`, stores non-secret recovery state. An 80-minute lease, heartbeat renewal, and monotonically increasing generation fence ensure only one worker can mutate at a time. Git, GitHub, and Cloudflare state are authoritative if checkpoint text disagrees.

Every branch, PR, merge, deployment, and cleanup action is idempotent: reconcile first, then perform only the first objectively incomplete step. High-impact actions require a fresh ownership/fencing check.

## Monetization decision

The first authorized worker researches the current market, considers several product-aligned monetization options, selects exactly one based on evidence, and freezes it in `MONETIZATION_EXPERIMENT.md`. The customer, offer category/value exchange, success/failure criteria, and deadline cannot later be changed to rescue a weak result.

## Implementation rules

Implementation must stay small and directly support the frozen hypothesis. Existing repository conventions are preserved. Behavioral changes use tests first where practical. At minimum, relevant changes must pass clean install, typecheck, unit tests, build, stdio smoke, GitHub CI, and outside-in production verification when the Worker changes.

The real Wrangler configuration is never committed. Deployment reconstructs an ephemeral config from the current live Worker topology, uses `--keep-vars`, performs a dry-run first, makes no D1/KV/DO/schema/binding mutations, and smoke-tests production immediately after deployment.

## Git hygiene

Substantive work happens on a dedicated experiment branch/worktree, not directly on main. PR and commit messages are short and factual. Merge is exact-head-SHA gated and never bypasses failed checks. After a successful merge/deploy, temporary work branches/worktrees/configs/processes are cleaned. The control branch is deleted only after the terminal outcome is durable on main.

## Terminal behavior

Before the deadline, a verified monetary event permanently sets SUCCESS; subsequent wakes preserve and verify the winning mechanism rather than pivoting. At the deadline, the terminal verdict is exactly SUCCESS, FAIL, or UNVERIFIED, followed by a concise postmortem and full experiment cleanup.
