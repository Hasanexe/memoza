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
| `last_comment_at` | INTEGER | Unix ms — set only by a comment insert (never by a content edit), so it can be compared to a grant's `last_viewed_at` to mean "new comment" specifically. Nullable (no comment yet). Not rolled back on comment delete (accepted staleness) |
| `page_no` | INTEGER | Owner's permanent notebook position, assigned once from `owner_page_seq` on create; never reused, never reassigned. NULL for notes that predate the pages feature until backfilled. Server-visible plaintext (see crypto spec) |
| `is_public` | INTEGER NOT NULL DEFAULT 0 | 1 once the owner has published this page. One-way: no code path clears it back to 0 — removing public visibility means trashing/purging the note (see Lifecycle) |

Indexes: `idx_note_owner` on `(owner_id)`; `idx_note_updated` on `(updated_at)`;
`idx_note_owner_page` on `(owner_id, page_no)` — prev/next/jump-to-page lookups.

## `owner_page_seq`

One row per owner; the authoritative, monotonically-increasing counter behind
`note.page_no`. A counter (not `MAX(page_no)+1`) is required because a page
number must never be reused, even after the note holding it is trashed and
swept — `MAX` would drop once the highest-numbered note is gone.

| Column | Type | Notes |
|---|---|---|
| `owner_id` | TEXT PK | |
| `next_page` | INTEGER NOT NULL DEFAULT 1 | The next page number to assign. Bumped atomically (`UPDATE … SET next_page = next_page + 1 WHERE owner_id = ? RETURNING next_page`, or read-then-write inside the same statement) on `PUT /notes/{id}` **create only** |

## `note_grant`

One user's access to a note. The owner writes content; every other grant is
read-only (no permission column — authorization is `note.owner_id == caller`).

| Column | Type | Notes |
|---|---|---|
| `note_id` | TEXT NOT NULL → note.id | |
| `user_id` | TEXT NOT NULL | Participant; owner or share recipient |
| `wrapped_cek` | TEXT NOT NULL | The note's CEK wrapped for this user; blanked to `''` on purge/revoke |
| `wrap_method` | TEXT NOT NULL | `dek` (owner, symmetric) or `pubkey` (recipient, RSA-OAEP) |
| `username` | TEXT | Participant's canonical username, denormalized (immutable, so never stale). For recipients: set from the share request. For the owner's own grant: backfilled from `X-Username` the next time the owner opens the note (`GET /notes/{id}`), so a recipient can be shown who shared it. Powers both the owner's recipient list and the "shared by" label without an auth-service lookup |
| `last_viewed_at` | INTEGER NOT NULL DEFAULT 0 | Unix ms this user last opened the note (`GET /notes/{id}` sets it to now); set to the grant's creation time on create/share so pre-access comment activity never shows as unread. Compared against `note.last_comment_at` to compute `has_unread_comment` in the list feed |
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
| `author_username` | TEXT | Commenter's public username, set from the trusted `X-Username` header at post time; shown as-is. Also the delete-authorization key (author = matching username). Null on legacy comments predating the username migration |
| `body_ct` | TEXT NOT NULL | base64(iv ‖ AES-256-GCM(cek)) of the comment text (AAD = comment `id`) |
| `created_at` | INTEGER NOT NULL | Unix ms |

Index: `idx_comment_note` on `(note_id, created_at)` — list a note's thread in
order and drop all comments on purge. A comment insert also bumps `updated_at`
on every grant of the note so the activity reaches each participant's sync.

## `public_page`

The **plaintext** publication of a page, entirely separate from the encrypted
`note` row — see the crypto spec's "Public pages" section. Written on
`POST /notes/{id}/publish` and re-written from the plaintext mirror fields the
owner's client sends with every subsequent `PUT` update (live mirror). The row
carries no lifecycle flags of its own: the internal read endpoint always joins
`note` and serves only when `deleted_at IS NULL AND purged_at IS NULL`.
Deleted in the **same atomic batch** as the purge that tombstones its note;
the lazy sweep additionally deletes any orphaned row whose note is gone. This
is the only table in `memoza_notes` holding plaintext content — tags are never
written here.

| Column | Type | Notes |
|---|---|---|
| `owner_id` | TEXT NOT NULL | Matches `note.owner_id`; part of the public lookup key |
| `page_no` | INTEGER NOT NULL | Matches `note.page_no`; part of the public lookup key |
| `note_id` | TEXT NOT NULL → note.id | |
| `title` | TEXT NOT NULL | Plaintext, mirrored from the owner's decrypted title on publish/edit |
| `body` | TEXT NOT NULL | Plaintext, mirrored from the owner's decrypted body on publish/edit |
| `format` | TEXT NOT NULL | `md` or `html` — picks the public reader's renderer, same as the note's `format` control tag |
| `updated_at` | INTEGER NOT NULL | Unix ms of the last mirror write. Internal bookkeeping only — never returned to the public caller (the gateway returns only `title`/`body`/`format`) |

PK (`owner_id`, `page_no`). This is the only table an unauthenticated request
ever reads (via the internal public-page endpoint the gateway calls).

## `sweep`

Single-row bookkeeping table that guards the lazy trash/tombstone sweep so it
runs at most once per `PURGE_SWEEP_INTERVAL_MS` regardless of concurrent
`GET /notes` full syncs.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Always `1` (`CHECK (id = 1)`) |
| `last_run` | INTEGER NOT NULL | Unix ms of the last sweep; claimed via `UPDATE … WHERE id=1 AND last_run<?` (compare-and-swap, prevents stampede) |
