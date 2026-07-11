# Data Model — `memoza_notes` (D1)

One database, owned exclusively by `memoza-notes`. All queries scoped by
`user_id` from the trusted header. Envelope/format definitions are in the
canonical crypto spec (`docs/architecture/README.md`).

## `note`

All shared content and state; the only per-user field lives on the grant.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID, **client-generated** (enables idempotent `PUT` create / offline replay); server rejects a non-UUID |
| `owner_id` | TEXT NOT NULL | Set from the trusted header on create; never client-supplied. Sole writer of content |
| `title_ct` | TEXT NOT NULL | base64(iv ‖ AES-256-GCM(cek)) of the title; `''` once purged |
| `body_ct` | TEXT NOT NULL | base64(iv ‖ AES-256-GCM(cek)) of the Markdown body; `''` once purged |
| `tags_ct` | TEXT | base64(iv ‖ AES-256-GCM(cek)) of the shared tag list (JSON array); nullable; `''` once purged |
| `rev` | INTEGER NOT NULL DEFAULT 1 | Bumped on every content write; optimistic-concurrency check |
| `created_at` | INTEGER NOT NULL | Unix ms |
| `updated_at` | INTEGER NOT NULL | Unix ms, server-set on every write; sync cursor |
| `deleted_at` | INTEGER | Unix ms — set = in trash, NULL = live |
| `purged_at` | INTEGER | Unix ms — set = tombstone (ciphertext blanked, grants + comments dropped) |

Indexes: `idx_note_owner` on `(owner_id)`; `idx_note_updated` on `(updated_at)`.

## `note_grant`

One user's access to a note. The owner writes content; every other grant is
read-only (no permission column — authorization is `note.owner_id == caller`).

| Column | Type | Notes |
|---|---|---|
| `note_id` | TEXT NOT NULL → note.id | |
| `user_id` | TEXT NOT NULL | Participant; owner or share recipient |
| `wrapped_cek` | TEXT NOT NULL | The note's CEK wrapped for this user; blanked to `''` on purge/revoke |
| `wrap_method` | TEXT NOT NULL | `dek` (owner, symmetric) or `pubkey` (recipient, RSA-OAEP) |
| `pinned` | INTEGER NOT NULL DEFAULT 0 | This user's pin (plaintext flag) — the only per-user field |
| `updated_at` | INTEGER NOT NULL | Unix ms, server-set; sync cursor |
| `revoked_at` | INTEGER | Unix ms — set when the owner revokes this grant via unshare; the row survives (wrapped_cek blanked) until `TOMBSTONE_RETENTION_DAYS` so the keyset sync can still emit it under `revoked`, then the lazy sweep deletes it |

PK (`note_id`, `user_id`). Indexes: `idx_grant_user_updated` on
`(user_id, updated_at, note_id)` — keyset list/sync cursor (the `note_id`
tiebreaker makes same-`updated_at` paging exact); `idx_grant_note` on
`(note_id)` — participant lookup, purge, and the write-time
"bump all grants of this note" update.

## `note_comment`

One participant's comment on a note; body encrypted with the note's CEK.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID, **client-generated** (idempotent `POST` replay) |
| `note_id` | TEXT NOT NULL → note.id | |
| `author_id` | TEXT NOT NULL | Set from the trusted header; any participant |
| `body_ct` | TEXT NOT NULL | base64(iv ‖ AES-256-GCM(cek)) of the comment text (AAD = comment `id`) |
| `created_at` | INTEGER NOT NULL | Unix ms |

Index: `idx_comment_note` on `(note_id, created_at)` — list a note's thread in
order and drop all comments on purge. A comment insert also bumps `updated_at`
on every grant of the note so the activity reaches each participant's sync.

## `sweep`

Single-row bookkeeping table that guards the lazy trash/tombstone sweep so it
runs at most once per `PURGE_SWEEP_INTERVAL_MS` regardless of concurrent
`GET /notes` full syncs.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Always `1` (`CHECK (id = 1)`) |
| `last_run` | INTEGER NOT NULL | Unix ms of the last sweep; claimed via `UPDATE … WHERE id=1 AND last_run<?` (compare-and-swap, prevents stampede) |
