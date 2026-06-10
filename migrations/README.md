# Migrations

Apply in filename order with:

```bash
npx wrangler d1 migrations apply digestseo-db --remote   # production
npx wrangler d1 migrations apply digestseo-db --local    # wrangler dev
```

## Why is there no 0004?

`0004` was an internal-only data cleanup run against the production fork
and was intentionally never published — its job is covered for OSS
deployments by `0005_response_status.sql` plus the
`POST /admin/cleanup-failed-runs` admin route. The gap in numbering is
expected.

**Do not renumber the files.** Wrangler tracks applied migrations by
filename in the `d1_migrations` table; renaming a file makes existing
deployments think it was never applied and re-runs it.
