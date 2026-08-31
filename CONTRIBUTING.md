# Contributing

Thanks for being here. PRs and issues both welcome.

By participating in this project, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Quick start

```bash
git clone https://github.com/YOUR-FORK/mcp-geo.git
cd mcp-geo
npm install
cp wrangler.example.jsonc wrangler.jsonc   # fill in your own IDs
cp .dev.vars.example .dev.vars             # fill in your own keys
npm run dev                                # wrangler dev on localhost:8787
```

## Before opening a PR

- `npm run typecheck` and `npm run test:unit` must pass (CI runs both on every push).
- If your change touches `/admin/*` routes, `/mcp` tools, or D1
  schema, run the smoke tests against a deployed branch:
  `GEO_BASE_URL=https://your-preview-deploy npm run test:smoke`.
- One feature per PR — easier to review, easier to revert.
- Keep commit messages descriptive: `fix(perplexity): handle empty
  citations array` is better than `bugfix`.

## What changes are likely to be merged

- New engine adapters that fit the existing `runLive(env, brand, prompts, runId)` contract.
- Bug fixes with a clear reproduction.
- Documentation that closes a gap users actually hit.
- Test improvements.

## What is unlikely to land without prior discussion

- New top-level routes outside `/mcp` and `/admin/*` (the OSS build
  intentionally has no public web UI).
- Adding a database other than D1, or a job queue (the cron + Durable
  Object pattern is deliberately simple).
- Anything that requires a paid Cloudflare plan to use.

Open an issue first if you're planning a large change, so we can
agree on the shape before you spend time on it.

## Questions

Open a GitHub issue with the `question` label. Avoid emailing maintainers
directly — questions in public help the next person.
