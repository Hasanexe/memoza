# Notes Service — `memoza-notes`

Stores and syncs end-to-end-encrypted Markdown notes, their per-note key
grants, read-only sharing, comments, and shared tags. The service never sees
plaintext or any usable key — it moves ciphertext and wrapped keys only (crypto
spec: `docs/architecture/README.md`). Data model: `table.md`.

## Component view

Single Cloudflare Worker, D1 database `memoza_notes`, no public route.
Reachable only through `memoza-gateway` via the `NOTES` service binding, plus an
internal purge endpoint reachable from `memoza-auth`. Identity comes exclusively
from the gateway-set `X-User-Id` header, and every query is scoped by that user.
No R2, no cron — Markdown text only in v1.

## Access model — notes, grants, comments

- A **note** holds all shared content and state: `owner_id`, `title_ct`,
  `body_ct`, `tags_ct` (shared, owner-authored tags), `rev`, timestamps,
  trash/tombstone state. The only per-user field lives on the grant.
- A **grant** (`note_grant`) is one user's access to a note: `wrapped_cek`,
  `wrap_method` (`dek`/`pubkey`), and that user's own `pinned` flag. **A user
  sees a note iff a grant exists.** There is no per-grant permission — the owner
  (`note.owner_id`) is the sole writer of content; every other grant is
  read-only.
- A **comment** (`note_comment`) is one participant's feedback on a note:
  `author_id`, `body_ct` (encrypted with the note's CEK), timestamps. Any
  participant may post; the author or the note owner may delete.

## Endpoint map

All responses JSON, errors `{ "error": "…" }`. Every query scoped by
`X-User-Id`.

| Endpoint | Purpose |
|---|---|
| `GET /notes?since={cursor}&limit={n}` | The one list/sync endpoint (full sync = omit `since`). Keyset-paginated feed of the caller's grants joined to notes: `note_id, title_ct, tags_ct, owner_id, pinned, rev, timestamps`, plus tombstones and revoked grants — never bodies or comments. Returns a `next` cursor; page until it's null |
| `GET /notes/{id}` | Full note incl. `body_ct` and the caller's `wrapped_cek` (404 if no grant) |
| `PUT /notes/{id}` | **Idempotent create-or-update** with a client-generated `id`. Create: `{title_ct, body_ct, tags_ct, wrapped_cek}`. Update (owner only): add `base_rev` → `409` on mismatch. Re-sending an identical create is a no-op |
| `DELETE /notes/{id}` | Owner: move note to trash. Non-owner: no-op/403 (they can't trash others' notes) |
| `POST /notes/{id}/restore` | Owner: un-trash |
| `DELETE /notes/{id}/purge` | Owner: permanent delete → tombstone |
| `PATCH /notes/{id}/grant` | Caller's own view: `{pinned}` (the only per-user field) |
| `POST /notes/{id}/share` | Owner: `{recipient_id, wrapped_cek}` → insert a read-only share grant |
| `DELETE /notes/{id}/share/{user_id}` | Owner: revoke a share grant |
| `GET /notes/{id}/comments` | Any participant: list a note's comments (`id, author_id, body_ct, timestamps`) |
| `POST /notes/{id}/comments` | Any participant: `{id, body_ct}` (client-generated `id`) → insert; bumps the note's grants |
| `DELETE /notes/{id}/comments/{comment_id}` | Comment author or note owner: delete a comment |
| `POST /notes/internal/purge-user` | Internal only (from `memoza-auth`): delete all of a user's owned notes, their grants, and comments |

## Sync & conflict model

The feed is **grant-driven and keyset-paginated**, so one query serves both
full and delta sync and it is correct under same-millisecond writes:

- Every write bumps `updated_at` on **all grants of the affected note** (not
  just the note row). An owner content edit, or a comment by any participant,
  therefore surfaces to every participant's feed, even though only the note's
  `rev` (or a comment row) changed. A pin change bumps just that grant.
- Sync reads the caller's grants ordered by the compound key
  `(updated_at, note_id)` and returns rows strictly greater than the client's
  `since` cursor, capped at `limit`. The response carries a `next` cursor
  (the last row's `(updated_at, note_id)`), or null when caught up. The `id`
  tiebreaker removes the same-`updated_at` skip/duplicate hazard of a bare
  timestamp cursor. `tombstones` and `revoked` ids ride the same feed.
- **Idempotent writes.** The client generates the note `id` (a UUID) and uses
  `PUT /notes/{id}`. A retried create (offline queue replay after a lost
  response) is a no-op instead of a duplicate note.
- **Compare-and-swap concurrency.** An owner update is a single
  `UPDATE … WHERE id=? AND rev=?`; if it affects zero rows the server returns
  `409` with the current row. No read-then-write, so two concurrent owner edits
  can't both win.
- **Conflict resolution.** Only the owner writes content, so conflicts arise
  solely across the **owner's own devices** (e.g. a desktop edit made offline
  vs. a later web edit). On `409` the client saves its losing version as a **new
  note it owns** (a private fork) and accepts the server row. No server-side
  merge is possible — the server can't read content.

## Lifecycle: trash → purge → tombstone

- `DELETE` (owner) sets `deleted_at`; trashed notes stay restorable for
  `TRASH_RETENTION_DAYS` (var, 30).
- Purging (explicit, or lazy expiry during `GET /notes`) blanks `title_ct` /
  `body_ct` / `tags_ct`, drops all grants and comments, and sets `purged_at` —
  the row becomes a tombstone so every participant's device learns of the
  deletion.
- Tombstones older than `TOMBSTONE_RETENTION_DAYS` (var, 90) are deleted during
  the same lazy sweep; a device offline longer must do a full re-list.

## Decisions

- **Per-note CEK + grants, not direct DEK encryption** — the only model that
  lets one note be shared without exposing the rest. Owner grants use the DEK
  (fast symmetric bulk unwrap); share grants use the recipient's public key.
  Rejected: encrypting notes with the DEK directly (unshareable); a shared
  group key per user-pair (doesn't scale, complicates revocation).
- **Shared tags on the note, encrypted with the CEK; only `pinned` is per-user**
  — tags describe the note itself, so they live on the note (`tags_ct`, CEK-
  encrypted) and every participant sees the owner's tags; the owner authors them
  as note content. Per-user organization is a client concern ("My notes" /
  "Shared with me" + tag filter), needing no per-user server state beyond the
  `pinned` flag. Rejected: per-user tags/folders on the grant (more schema and
  sync surface to give each user an independent filing system that the client
  already provides).
- **No folders** — nested folders duplicate what tags already do (a
  `country`/`city` folder path is just two tags) and create a "which folder does
  a shared note live in" problem. Dropped entirely in favor of multi-tag
  filtering. Rejected: per-user folder tree (extra table, endpoints, sync
  stream, and a shared-note placement ambiguity).
- **Tags stay encrypted** — search and tag-filtering run client-side over the
  locally decrypted notes, so plaintext tags on the server buy **no** search
  benefit while leaking sensitive labels (e.g. "medical", "legal"). If
  server-side tag filtering is ever needed at scale, store an HMAC(tag) token
  (equality-filterable, text-hiding) rather than plaintext. Rejected: plaintext
  tags.
- **Read-only sharing + comments, not multi-writer** — only the owner edits a
  note's content, so there is no per-grant permission and no cross-user write
  race; recipients contribute through a comment thread (each comment CEK-
  encrypted, any participant may post). This deletes the read-write conflict
  dimension while still supporting collaboration. Rejected: read-write share
  grants (concurrent multi-user edits over ciphertext force keep-both forks with
  no possible server merge).
- **Client-generated ids + `PUT` upsert** — offline-first replay must be
  idempotent; a server-generated id makes a retried create a duplicate.
- **Compare-and-swap on `rev`, not read-then-write** — D1 statements are
  individually atomic but a read-then-conditional-write across two awaits
  races; a single guarded `UPDATE` is correct and cheaper.
- **Keyset sync over `(updated_at, note_id)` with a page `limit`** — bounds
  response size and worker memory (a user with thousands of notes never returns
  them in one shot) and is exact under same-ms writes. `MAX_SYNC_LIMIT` var.
- **Soft revocation** — `DELETE /share` drops the grant; a recipient who cached
  the CEK keeps historical access. CEK rotation is deferred (documented in the
  crypto spec).
- **Lazy purge instead of cron** — the sweep runs inside a full sync (called on
  app open), guarded so it fires at most once per `PURGE_SWEEP_INTERVAL_MS`
  (tracked in a tiny `sweep` bookkeeping row) rather than on every request, so
  it never adds write latency to the hot read path or stampedes under
  concurrent syncs. Rejected: worker cron (more moving parts on the free tier).
  Revisit with a scheduled internal call once off the free tier.
- **Titles encrypted separately from bodies** — list/sync stay cheap; the
  plaintext-metadata cost is only counts, sizes, timestamps, participant ids,
  and the `pinned` flag (accepted, see crypto spec).
- **Size caps as vars** — `MAX_TITLE_CT_BYTES` (2,048), `MAX_BODY_CT_BYTES`
  (512,000), `MAX_TAGS_CT_BYTES` (2,048), `MAX_COMMENT_CT_BYTES` (8,192),
  `MAX_SYNC_LIMIT` (200), validated/clamped on every request.
- **Account-deletion purge is an internal endpoint** — auth can't touch this
  service's D1; the notes service owns and deletes its own data. The purge is
  **chunked and idempotent** (delete in bounded batches, safe to re-invoke) so a
  user with many notes can't exceed a single worker's CPU/subrequest budget.
- **Purged/revoked grants are soft-marked, not immediately dropped** — "drops
  all grants" (purge) and "revoke a grant" (unshare) both need to still reach
  the affected user's keyset sync feed after the fact, but a hard `DELETE`
  would make the row invisible to the `(user_id, updated_at, note_id)` keyset
  query that drives sync. So purge sets `note.purged_at` and blanks the note's
  ciphertext (grants stay, `wrapped_cek` blanked); unshare sets
  `note_grant.revoked_at` and blanks that grant's `wrapped_cek`. `GET /notes`
  classifies each row by these flags into `notes` / `tombstones` / `revoked`.
  The lazy sweep physically deletes rows once `purged_at` /
  `revoked_at` is older than `TOMBSTONE_RETENTION_DAYS`, matching the
  documented tombstone-retention window. See `table.md`.
- **Share grant references an unvalidated `recipient_id`** — the notes DB has no
  users table, so it can't confirm the recipient exists or that `wrapped_cek`
  was wrapped to their real key (both are opaque). This only ever hurts the
  sharer's chosen recipient (a bad wrap = they can't decrypt); it's not a
  cross-user security hole. Accepted; the client validates via the public-key
  lookup before sharing.

## Changes

- 2026-07-07 — Initial single-user design.
- 2026-07-08 — Reworked to per-note CEK + grants for sharing; added share/
  unshare, read-write permissions, per-user folders/tags, and the internal
  purge-user endpoint.
- 2026-07-08 (review) — Hardened for offline-first + scale: client-generated
  ids with idempotent `PUT` create, compare-and-swap concurrency, keyset
  paginated grant-driven sync, guarded lazy purge, chunked purge-user; kept
  tags encrypted (no search benefit to plaintext).
- 2026-07-09 (review) — Dropped folders; moved tags to the note (shared,
  CEK-encrypted) leaving only `pinned` per-user; made sharing read-only
  (removed the `permission` column) and added a CEK-encrypted comment thread;
  conflicts now only span the owner's own devices.
- 2026-07-10 (review) — Fixed `internal-purge.ts` (account-deletion purge) to
  soft-tombstone owned notes and revoke non-owned grants, matching the
  documented lifecycle, instead of hard-deleting `note`/`note_grant` rows
  immediately; also batched the per-note delete loop into one statement per
  chunk and gave `sweep.ts`'s tombstone cleanup a bounded `LIMIT` per
  statement so it stays chunked and re-invokable under load.
- 2026-07-10 (implemented) — Built `notes-service` against this README/table
  (the `IMPLEMENTATION-PLAN.md` had gone stale — still described folders and a
  grant `permission` column that this doc had already dropped on 2026-07-09;
  built to the README, not the plan). Added `note_grant.revoked_at` and the
  `sweep` bookkeeping table (not previously in `table.md`) to make tombstone/
  revoked propagation and the guarded lazy sweep concrete. Plan deleted.
