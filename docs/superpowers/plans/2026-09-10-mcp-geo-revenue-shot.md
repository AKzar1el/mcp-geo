# mcp-geo Revenue Shot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze and launch one evidence-backed, repo-native monetization experiment for mcp-geo, then verify it through local tests, GitHub CI, production deployment, and outside-in smoke checks.

**Architecture:** Keep the orchestration state on the temporary control branch and keep customer-facing changes on one experiment branch from current `origin/main`. The first phase freezes a fixed-price offer in `MONETIZATION_EXPERIMENT.md`; the implementation exposes that offer through the README and a dedicated stateless `/audit` Worker route without changing MCP/OAuth behavior. GitHub remains the merge gate and Cloudflare deployment uses reconstructed live bindings plus dry-run verification.

**Tech Stack:** TypeScript, Cloudflare Workers, Node.js 22+, npm, Git/GitHub Actions, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-10-mcp-geo-revenue-shot-design.md`

## Global Constraints

- Mutate only `AKzar1el/mcp-geo` and its existing `digestseo-mcp` Worker.
- Frozen experiment success is real attributable revenue greater than EUR 0; diagnostics do not count.
- No cold outreach, paid ads, new financial accounts, hidden telemetry, test weakening, schema/binding migrations, or edits to other repositories.
- Production deployment must reconstruct current live bindings, preserve dashboard vars/secrets, dry-run first, and smoke-test after deploy.
- Every high-impact side effect requires current lease/generation fencing authority.

---

### Task 1: Freeze the evidence-backed offer

**Files:**
- Create: `MONETIZATION_EXPERIMENT.md`

**Interfaces:**
- Consumes: current market evidence, current repo capabilities, fixed experiment deadline.
- Produces: immutable customer, offer, value exchange, success/failure criteria, and deadline for all later tasks.

- [ ] **Step 1: Confirm current market and repo evidence**

Verify current pricing/demand sources and current README capabilities. Record only sources retrieved on 2026-09-10 or current first-party repository evidence.

- [ ] **Step 2: Commit the frozen experiment contract**

Create `MONETIZATION_EXPERIMENT.md` with the selected offer, target buyer, exact scope, contact/payment path, source URLs, diagnostic metrics, and explicit frozen fields. Commit it before implementing the offer.

- [ ] **Step 3: Update control checkpoint**

Record the frozen commit SHA, phase, active work branch, and heartbeat on `experiment/revenue-shot-control` using normal fast-forward Git semantics.

### Task 2: Add a tested public audit surface

**Files:**
- Create: `src/public-audit.ts`
- Create: `tests/unit/public-audit.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: frozen offer from `MONETIZATION_EXPERIMENT.md`.
- Produces: `paidAuditResponse(origin: string): Response`, served only at `GET /audit`.

- [ ] **Step 1: Write failing tests for the audit response**

Test that `paidAuditResponse()` returns HTML with the exact frozen price, scope, contact path, non-deceptive OSS framing, and no-cache headers. Test that no secrets or claims of active GitHub Sponsors appear.

- [ ] **Step 2: Run the focused test and confirm RED**

Run `node --import tsx --test tests/unit/public-audit.test.ts`. Expected result: failure because `src/public-audit.ts` does not yet exist.

- [ ] **Step 3: Implement the smallest stateless page renderer**

Add `paidAuditResponse(origin: string): Response` in `src/public-audit.ts`. It must return a compact accessible HTML document with one primary `mailto:info@tomiseregi.si` CTA and explicit link back to the free/open-source repository/MCP endpoint. No database, analytics, cookies, client JavaScript, payment SDK, or new dependency.

- [ ] **Step 4: Route only GET `/audit`**

In `src/index.ts`, import `paidAuditResponse`; route `GET /audit` to it and return 405 with `Allow: GET` for other methods. Do not change `/`, `/mcp`, `/authorize`, admin routes, OAuth, cron behavior, bindings, or storage.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run `node --import tsx --test tests/unit/public-audit.test.ts`. Expected: all new audit tests pass.

### Task 3: Add the conversion path to README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: frozen offer and deployed `/audit` URL.
- Produces: one concise paid-service CTA while preserving all free/self-host/install paths.

- [ ] **Step 1: Add one bounded CTA near the existing hosted-version paragraph**

Add a short section/link explaining that users who want the result without setup can order the frozen one-time audit at `https://geo-mcp.digestseo.com/audit`. Keep local/self-hosted mcp-geo free and unchanged.

- [ ] **Step 2: Avoid unsupported claims**

Check that README copy says `up to five` engines where availability depends on configured providers, does not claim GitHub Sponsors is live, and does not promise outcomes/citations/rank improvements.

### Task 4: Full local qualification and candidate commit

**Files:**
- Verify all changed files from Tasks 1-3.

**Interfaces:**
- Consumes: candidate branch.
- Produces: exact qualified candidate SHA.

- [ ] **Step 1: Clean-install and typecheck**

Run `npm ci` and `npm run typecheck`. Expected: exit 0.

- [ ] **Step 2: Run unit suite**

Run `npm run test:unit`. Expected: all existing plus new tests pass.

- [ ] **Step 3: Build and stdio-smoke**

Run `npm run build` and `npm run test:stdio`. Expected: exit 0; local MCP JSON-RPC smoke remains unchanged.

- [ ] **Step 4: Review diff scope**

Verify only `MONETIZATION_EXPERIMENT.md`, `src/public-audit.ts`, `src/index.ts`, `tests/unit/public-audit.test.ts`, and `README.md` are customer-facing candidate changes. No workflow, migration, auth, secret, dependency, or binding files may change.

- [ ] **Step 5: Commit and push candidate**

Use a short factual commit message and push the experiment branch normally.

### Task 5: GitHub PR and independent CI gate

**Files:**
- No additional repository files unless a deterministic CI defect is reproduced.

**Interfaces:**
- Consumes: exact candidate head SHA.
- Produces: one PR to `main`, CI evidence, and exact merge SHA if accepted.

- [ ] **Step 1: Re-check fencing and target repository**

Verify current control-branch `active_run_id`, `generation`, lease validity, and GitHub repo full name before PR mutation.

- [ ] **Step 2: Create one concise PR**

Title: `feat: add fixed-price AI visibility audit`. Body has only market rationale, exact change, and verification commands/results.

- [ ] **Step 3: Wait via state, not busy polling**

If GitHub Actions are still running and no useful work remains, checkpoint `WAITING_GITHUB` with PR number and head SHA and exit. A later wake resumes here.

- [ ] **Step 4: Merge exact qualified head**

When required Node 22/24 CI is green, refetch PR/main, verify no conflict/head movement, re-check fencing, and squash-merge using the exact expected head SHA.

### Task 6: Production deploy and outside-in verification

**Files:**
- Temporary local file only: an ephemeral Wrangler config reconstructed from current production; never commit it.

**Interfaces:**
- Consumes: merged main SHA and current live Worker topology.
- Produces: live `/audit` page on the existing Worker with all legacy MCP/health/auth behavior preserved.

- [ ] **Step 1: Re-discover current Worker topology**

Use read-only Wrangler/Cloudflare inspection. Confirm the Worker name/domain, current D1/KV/Durable Object/service bindings, compatibility configuration, cron, and existing variables without reading secrets.

- [ ] **Step 2: Build ephemeral deploy config and dry-run**

Reconstruct current production bindings exactly, set keep-vars behavior, and run Wrangler dry-run. Compare binding summary to live topology. Any unexpected difference stops deployment.

- [ ] **Step 3: Re-check fencing and deploy exact merged candidate**

Only with current lease/generation ownership and clean qualification evidence, deploy the merged code to the existing Worker without resource/schema/binding mutation.

- [ ] **Step 4: Outside-in smoke**

Verify `GET /audit` returns 200 and contains the frozen offer/contact CTA. Re-check `/`, `/healthz`, `/authorize`, unauthenticated `/mcp`, and unauthenticated `/admin/run-engine` for unchanged expected behavior.

- [ ] **Step 5: Clean deployment artifacts**

Delete ephemeral config; verify working tree clean.

### Task 7: Merge hygiene and transition to market wait

**Files:**
- Update: `MONETIZATION_EXPERIMENT.md` only if recording shipped SHA/URL without changing frozen fields.
- Update temporary control state on `experiment/revenue-shot-control`.

**Interfaces:**
- Consumes: merged/deployed verified state.
- Produces: clean repo and `WAITING_MARKET` checkpoint.

- [ ] **Step 1: Record immutable shipped evidence**

Record the merge/deployment evidence and public `/audit` URL without changing any frozen field.

- [ ] **Step 2: Remove merged work branch/worktree artifacts**

Delete remote merged branch, safely delete local merged branch/worktree if applicable, prune refs, and verify no experiment implementation worktree remains.

- [ ] **Step 3: Set `WAITING_MARKET`**

Checkpoint the control branch with exact main/PR/deployment evidence and revenue status. Subsequent wakes only act on new evidence or incomplete recovery work; no hourly copy churn.
