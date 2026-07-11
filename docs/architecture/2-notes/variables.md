# Variables & Secrets — `memoza-notes`

Quick reference only. Design rationale: `README.md`.

## Vars (`notes-service/wrangler.jsonc`)

| Var | Purpose |
|---|---|
| `MAX_TITLE_CT_BYTES` | Size cap on a note's encrypted title |
| `MAX_BODY_CT_BYTES` | Size cap on a note's encrypted body |
| `MAX_TAGS_CT_BYTES` | Size cap on a note's encrypted tag list |
| `MAX_COMMENT_CT_BYTES` | Size cap on a comment's encrypted body |
| `MAX_SYNC_LIMIT` | Server-clamped upper bound on `GET /notes` page size |
| `TRASH_RETENTION_DAYS` | How long a trashed note stays restorable before lazy purge |
| `TOMBSTONE_RETENTION_DAYS` | How long a purged/revoked tombstone row is kept before physical deletion |
| `PURGE_SWEEP_INTERVAL_MS` | Minimum gap between lazy sweep runs (guards against stampede) |

## Secrets

None. This worker has no public route and trusts identity only from the
gateway-set `X-User-Id` header.
