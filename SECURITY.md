# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub's private vulnerability reporting](https://github.com/AKzar1el/mcp-geo/security/advisories/new)
on this repository. Do **not** open a public issue for security problems.

You can expect an acknowledgement within a few days. Since this is a
self-hosted project, fixes ship as a new release — there is no hosted
infrastructure for the maintainers to patch on your behalf.

## Supported versions

Only the latest release receives security fixes.

## Security model (what you're deploying)

This is a **single-user, self-hosted** MCP server. The trust boundaries are:

- **`/admin/*` routes** are gated by the `SEED_SECRET` shared secret
  (`X-Seed-Secret` header, compared in constant time). Anyone with the
  secret can seed brands, trigger paid engine scans, and delete response
  rows. Treat it like an API key.
- **`/mcp` (the MCP endpoint)** requires an OAuth token. The `/authorize`
  step **fails closed with HTTP 503 unless `CONNECT_SECRET` is configured**.
  This protects against anyone who knows the Worker URL minting a token,
  reading visibility data or invoking paid `refresh_brand` scans. Set the
  required deployment secret before connecting an MCP client:

  ```bash
  npx wrangler secret put CONNECT_SECRET
  ```

  The browser authorization form requires that secret and a separate explicit
  approval of the requesting client before issuing a token. It displays the
  requesting client identifier and scope, but **these values are client-supplied,
  not independently verified identities**. Authorize only clients you recognize;
  a connected client may trigger provider calls that consume your API quota.
  The form is not cached and cannot be framed by other sites.
  Deployments upgrading from an earlier version must configure it; already
  issued OAuth tokens are not automatically revoked by this change.
- **Engine API keys** live in Cloudflare's encrypted secret store
  (`wrangler secret put`), never in `wrangler.jsonc` or the repo. They
  are only ever sent to their respective first-party APIs.
- **Your data stays in your account.** All state is in your own D1
  database; nothing is sent to the maintainers.

## Out of scope

- Multi-tenant isolation — the OSS build is single-user by design.
  Fork and replace `/authorize` with a real identity provider before
  exposing it to multiple end-users.
- Denial-of-wallet via a leaked `SEED_SECRET` or `CONNECT_SECRET` —
  rotate the secret (`wrangler secret put` again) if you suspect a leak.
