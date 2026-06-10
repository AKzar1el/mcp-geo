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
- **`/mcp` (the MCP endpoint)** requires an OAuth token. By default the
  `/authorize` step **auto-completes for any client that knows your
  worker URL** — convenient for a personal deploy, but it means a
  stranger who finds the URL can connect an MCP client, read your
  visibility data, and call `refresh_brand` (which spends your engine
  API credits). Set the optional `CONNECT_SECRET` secret to require a
  shared secret in the browser step of the OAuth flow:

  ```bash
  npx wrangler secret put CONNECT_SECRET
  ```

  **Recommended for every deployment whose URL is shared anywhere.**
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
