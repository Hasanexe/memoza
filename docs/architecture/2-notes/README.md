# Notes Service — `memoza-notes`

Stores and syncs end-to-end-encrypted Markdown notes, their per-note key
grants, read-only sharing, comments, shared tags, and permanent page numbers.
The service never sees plaintext or any usable key for a private note — it
moves ciphertext and wrapped keys only — **except for pages the owner
explicitly publishes**, which are mirrored as plaintext for anonymous public
reading (crypto spec: `docs/architecture/README.md`, "Public pages"). Data
model: `table.md`.

## Component view

Single Cloudflare Worker, D1 database `memoza_notes`, no public route.
Reachable only through `memoza-gateway` via the `NOTES` service binding, plus an
internal purge endpoint reachable from `memoza-auth`. Identity comes exclusively
from the gateway-set `X-User-Id` header, and every query is scoped by that user
— **with one exception**: the internal public-page endpoint (below) is
identity-free by design, since it serves already-published plaintext to
anonymous readers. No R2, no cron — Markdown text only in v1.

## Access model — notes, grants, comments

- A **note** holds all shared content and state: `owner_id`, `title_ct`,
  `body_ct`, `tags_ct` (shared, owner-authored tags — **pinning is one of
  these tags**, not a separate field), `rev`, `last_comment_at`, timestamps,
  trash/tombstone state, its permanent `page_no`, and `is_public`.
- A **grant** (`note_grant`) is one user's access to a note: `wrapped_cek`,
  `wrap_method` (`dek`/`pubkey`), and that user's own `last_viewed_at` (used
  to derive `has_unread_comment`). **A user sees a note iff a grant exists.**
  There is no per-grant permission — the owner (`note.owner_id`) is the sole
  writer of content; every other grant is read-only.
- A **comment** (`note_comment`) is one participant's feedback on a note:
  `author_username` (set from the trusted `X-Username` header), `body_ct`
  (encrypted with the note's CEK), timestamps. Any participant may post; the
  author (matched by username) or the note owner may delete.

## Endpoint map

All responses JSON, errors `{ "error": "…" }`. Every query scoped by
`X-User-Id`.

| Endpoint | Purpose |
|---|---|
| `GET /notes?since={cursor}&limit={n}` | The one list/sync endpoint (full sync = omit `since`). Keyset-paginated feed of the caller's grants joined to notes: `note_id, title_ct, tags_ct, owner_id, has_unread_comment, rev, timestamps`, plus tombstones and revoked grants — never bodies or comments. Returns a `next` cursor; page until it's null |
| `GET /notes/{id}` | Full note incl. `body_ct` and the caller's `wrapped_cek` (404 if no grant), plus `owner_username` (for the "shared by" label). For the owner, also returns `shares` (active recipients as `{user_id, username}`) for the share dialog, and backfills the owner's own grant `username` from `X-Username`. Also marks the note viewed: sets the caller's grant `last_viewed_at = now`, clearing `has_unread_comment` |
| `PUT /notes/{id}` | **Idempotent create-or-update** with a client-generated `id`. Create: `{title_ct, body_ct, tags_ct, wrapped_cek}`. Update (owner only): add `base_rev` → `409` on mismatch. If the note is published (`is_public=1`), the update must also carry plaintext `{title, body, format}` (live mirror — see Public pages): `400` without them, and `400` if they're sent for an unpublished note. Re-sending an identical create is a no-op |
| `DELETE /notes/{id}` | Owner: move note to trash. Non-owner: no-op/403 (they can't trash others' notes) |
| `POST /notes/{id}/restore` | Owner: un-trash |
| `DELETE /notes/{id}/purge` | Owner: permanent delete → tombstone |
| `POST /notes/{id}/share` | Owner: `{recipient_id, wrapped_cek, username}` → insert a read-only share grant (recipient's username denormalized onto the grant) |
| `DELETE /notes/{id}/share/{user_id}` | Owner: revoke a share grant |
| `GET /notes/{id}/comments` | Any participant: list a note's comments (`id, author_username, body_ct, timestamps`) |
| `POST /notes/{id}/comments` | Any participant: `{id, body_ct}` (client-generated `id`) → insert; bumps the note's grants |
| `DELETE /notes/{id}/comments/{comment_id}` | Comment author or note owner: delete a comment |
| `POST /notes/{id}/publish` | Owner: `{title, body, format}` **plaintext** → sets `is_public=1`, writes/mirrors the `public_page` row. `400` if the note has no `page_no` yet (pre-backfill legacy note — `public_page` is keyed by it). No unpublish; every subsequent owner `PUT` update carries the plaintext mirror fields (live mirror) |
| `GET /notes/internal/public/{owner_id}/{page_no}` | Internal only (from `memoza-gateway`, itself reached unauthenticated at the edge): serves the `public_page` row as plaintext JSON, or `404` if unpublished / the note is trashed or purged |
| `POST /notes/internal/purge-user` | Internal only (from `memoza-auth`): delete all of a user's owned notes, their grants, and comments |

## Sync & conflict model

The feed is **grant-driven and keyset-paginated**, so one query serves both
full and delta sync and it is correct under same-millisecond writes:

- Every write bumps `updated_at` on **all grants of the affected note** (not
  just the note row). An owner content edit (including a pin toggle, which is
  just a tag edit), or a comment by any participant, therefore surfaces to
  every participant's feed, even though only the note's `rev` (or a comment
  row) changed.
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

## Pages — permanent, per-owner numbering

The notebook model: every note an owner creates gets a permanent `page_no`,
never reused even after deletion. This is the one piece of the whole notebook
feature that had to move server-side:

- **Assignment**: `owner_page_seq(owner_id, next_page)` is a per-owner counter,
  bumped atomically on `PUT /notes/{id}` **create only** and stamped onto the
  new note's `page_no`. Shared-with-me notes are never numbered into your own
  sequence — only notes you own consume your counter.
- **Why a counter, not `MAX(page_no)+1`**: this is offline-first across
  devices — two devices creating a note while offline would both compute the
  same `MAX+1` and collide, and a number must never be reused even after its
  note is trashed and swept (which would lower the `MAX`). Only a monotonic
  counter satisfies "page 26 stays deleted forever."
- **Navigation is entirely client-side and free**: prev/next/jump-to-page sorts
  the client's already-synced owned notes by `page_no` and steps through them.
  No new endpoint.
- **Deleted-page display** (client-computed from existing `deleted_at` /
  `purged_at`, no extra storage): within the trash/tombstone retention window,
  a deleted page shows `page N · deleted <date>`. After the tombstone sweep the
  row is gone; the client shows "deleted" if the number is within the range
  it's ever synced, or "no page here yet" above its known high-water mark. If
  the *highest* pages were deleted and already swept, the client can't tell
  "deleted long ago" from "never created" for that tail — shown as "deleted or
  never existed" (documented, not worth extra storage to disambiguate).

## Public pages — opt-in plaintext publishing

Publishing turns one page into an anonymously-readable web page. This is a
deliberate, isolated break from the E2EE model (crypto spec: "Public pages") —
kept structurally separate from the private, grant-scoped note path rather than
bolted onto it:

- **Publish**: the owner's client already holds the decrypted content (it has
  the `cek`), so `POST /notes/{id}/publish` sends **plaintext**
  `{title, body, format}`. The server sets `note.is_public = 1` and writes a
  `public_page` row keyed by `(owner_id, page_no)`. The encrypted `note` row is
  untouched and stays the private source of truth.
- **Live mirror**: the server cannot decrypt, so the client supplies the
  mirror content itself — once `is_public = 1`, every owner `PUT` update must
  include plaintext `{title, body, format}` alongside the ciphertext fields,
  and the server re-writes the `public_page` row from them in the same
  request. A published-note update without the plaintext fields is `400`
  (the mirror can never silently go stale — e.g. an old client leaving
  deleted-by-the-owner content publicly served); plaintext fields on an
  unpublished note are also `400` (plaintext can never arrive for a private
  page). The mirror write is guarded by `deleted_at IS NULL AND purged_at IS
  NULL` in the same statement so a racing trash/purge can't resurrect the row.
  **Tags are never mirrored** — they stay encrypted even on published pages.
  No separate "re-publish" action.
- **No unpublish**: plaintext already served to a reader can't be revoked
  cryptographically, so there's no code path to clear `is_public` back to 0.
  The only way to stop serving a page is to delete it — trashing it stops the
  public route from serving it (see below), purging it deletes the
  `public_page` row outright.
- **Public read is a separate, unauthenticated internal endpoint**
  (`GET /notes/internal/public/{owner_id}/{page_no}`), reached only via
  `memoza-gateway`. The gateway exposes the actual public entry point,
  `GET api.memoza.io/public/{username}/{page_no}` (no JWT — like `/health`,
  answered before auth), resolves `username → owner_id` through `memoza-auth`
  first, then calls this endpoint with the resolved id (see the auth service
  design). The public site at `memozasites.com/{username}/{page_no}`
  (`memoza-sites`, `docs/architecture/4-public-sites/README.md`) consumes the
  gateway endpoint over a service binding. This keeps the
  identity-free read path physically separate from every `X-User-Id`-scoped
  endpoint above. Two hard requirements on the gateway side (it composes
  internal URLs from anonymous, attacker-controlled path parts): it must
  validate `page_no` (digits only) and `username` (registration charset)
  **before** building any internal URL — anything else is an immediate `404`,
  never forwarded (otherwise a crafted `page_no` like `1/../../purge-user`
  could path-traverse into other internal endpoints) — and it must return to
  the public caller **only** `{title, body, format}`, stripping everything
  else on the internal row (`owner_id`, `note_id`, `updated_at`) — nothing an
  anonymous reader doesn't strictly need.
- **Enumerable by design**: `username/1`, `username/2`, … are guessable; that's
  accepted for public content (crypto spec).

## Lifecycle: trash → purge → tombstone

- `DELETE` (owner) sets `deleted_at`; trashed notes stay restorable for
  `TRASH_RETENTION_DAYS` (var, 30). If the note is published, the public read
  endpoint immediately stops serving it (checks `deleted_at IS NULL`) —
  restoring within the window brings it back.
- Purging (explicit, or lazy expiry during `GET /notes`) blanks `title_ct` /
  `body_ct` / `tags_ct`, drops all grants and comments, deletes the
  `public_page` row if one exists, and sets `purged_at` — the row becomes a
  tombstone so every participant's device learns of the deletion. All of these
  statements run as **one atomic D1 `batch()`**, so a crash mid-purge can't
  leave a plaintext `public_page` row behind a tombstoned note.
- Tombstones older than `TOMBSTONE_RETENTION_DAYS` (var, 90) are deleted during
  the same lazy sweep; a device offline longer must do a full re-list. The
  sweep also deletes any orphaned `public_page` row whose `note_id` no longer
  exists (belt-and-braces — the read path never serves one anyway, since it
  joins the note's `deleted_at`/`purged_at` flags, but orphaned plaintext must
  not sit in the database after the owner purged it).

## Decisions

- **Per-note CEK + grants, not direct DEK encryption** — the only model that
  lets one note be shared without exposing the rest. Owner grants use the DEK
  (fast symmetric bulk unwrap); share grants use the recipient's public key.
  Rejected: encrypting notes with the DEK directly (unshareable); a shared
  group key per user-pair (doesn't scale, complicates revocation).
- **Shared tags on the note, encrypted with the CEK; pin is just a tag** —
  tags describe the note itself, so they live on the note (`tags_ct`, CEK-
  encrypted) and every participant sees the owner's tags; the owner authors
  them as note content. Pinning was originally a per-user grant flag; it's now
  the literal tag `"pin"`, so pin state is shared like any other tag (the
  owner pins it, every participant sees it pinned) — a deliberate simplicity
  tradeoff over keeping a separate per-user field for one boolean. Per-user
  organization otherwise stays a client concern ("My notes" / "Shared with
  me" + tag filter), needing no per-user server state. Rejected: per-user
  tags/folders on the grant (more schema and sync surface to give each user an
  independent filing system that the client already provides); keeping
  `pinned` on the grant while everything else moved to tags (two competing
  models for the same kind of per-note label).
- **Unread-comment tracking (`note.last_comment_at` + `note_grant.last_viewed_at`)**
  — the client wants to show a "new comment" indicator, which needs *some*
  persisted "did this user see the latest activity" state; nothing else in the
  schema captures it. Kept minimal: one nullable note-level timestamp set only
  by a comment insert (not by content edits, so it means "new comment"
  specifically) and one per-grant "last viewed" timestamp set by `GET
  /notes/{id}`. `has_unread_comment` is computed in the `GET /notes` query,
  never stored. Not rolled back on comment delete (accepted staleness — a
  deleted comment can leave a stale unread flag briefly; not worth a second
  query on every delete). Rejected: a separate read-receipts table (more
  schema for the same one boolean).
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
- **Schema managed via `wrangler d1 migrations`, not a hand-applied
  `schema.sql`** — the original `schema.sql` had no record of what was
  already live, so every change meant wiping and recreating the database.
  Replaced with `migrations/0001_init.sql` (the schema as of this review) and
  future changes are additive migration files (`ALTER TABLE`), applied with
  `wrangler d1 migrations apply memoza_notes --remote`; D1 tracks what's
  applied automatically. Rejected: continuing hand-applied `schema.sql`
  (data-destructive on every change, does not scale past the pre-launch
  phase).
- **Share grant references an unvalidated `recipient_id`** — the notes DB has no
  users table, so it can't confirm the recipient exists or that `wrapped_cek`
  was wrapped to their real key (both are opaque). This only ever hurts the
  sharer's chosen recipient (a bad wrap = they can't decrypt); it's not a
  cross-user security hole. Accepted; the client validates via the public-key
  lookup before sharing.
- **Page numbers via a per-owner counter table, not `MAX(page_no)+1`** — the
  client is offline-first across multiple devices, so a derived max can both
  collide (two offline devices create simultaneously) and shrink (the
  highest-numbered note gets trashed and swept), violating "never reused."
  A monotonic counter, bumped only on create, is the only structure that
  satisfies both offline safety and permanence. Rejected: client-chosen numbers
  (collision-prone offline); `MAX+1` (reuses numbers after deletion).
- **Public pages live in their own table and their own unauthenticated
  endpoint, not a flag on `note`** — every other endpoint in this service
  trusts identity exclusively from the gateway-set `X-User-Id` header; folding
  a public read path into that same surface would mean one code path has to
  branch between "trusted header present" and "anonymous," which is exactly
  the kind of authorization bug this service's whole design (see the internal-
  endpoint-isolation pattern in the auth service) tries to structurally avoid.
  A separate table + separate route makes "no identity, no problem" true by
  construction. Rejected: `is_public`-gated reads on `GET /notes/{id}`.
- **Publish is live-mirrored, not a frozen snapshot** — matches "the public
  link is my page," and since publishing is already irreversible there's no
  surprise in later edits also being visible. Rejected: snapshot-at-publish
  (would need an explicit re-publish action for no real benefit).
- **No unpublish endpoint** — plaintext already served to any reader can't be
  cryptographically revoked, so an "unpublish" button would be a false
  promise. Only delete (trash hides it, purge removes it) is offered, and the
  publish-time warning says so. Rejected: an unpublish flag (implies a
  guarantee the system can't keep).
- **Control tags (`color:`, `format:`, `pin`) stay inside the encrypted
  `tags_ct` array, classified client-side** — same reasoning as the existing
  "tags stay encrypted" decision: the client already decrypts every note to
  render it, so client-side classification and single-value enforcement (the
  registry in `frontend/core`) are free, while a plaintext control column would
  leak presentation/behavior data for zero server-side benefit. See
  `docs/architecture/frontend-core/README.md` for the registry and
  duplicate-prevention mechanism. The one exception is `is_public`, which
  **must** be server-visible plaintext because the server itself acts on it
  (serving the public route) — that's the line between "client-only control"
  and "server-enforced state" this service now draws.

## Changes

- 2026-07-23 — Identity on comments/shares moved to **username** (migration
  `0003`): `note_comment.author_id` → `author_username` (set from the trusted
  `X-Username` header; also the delete-auth key), and `note_grant` gained a
  denormalized `username` (from the share request). `POST /share` now takes a
  `username`; `GET /notes/{id}` returns the owner's active recipient `shares`
  (no auth-service lookup). Enables username-based sharing and username-labelled
  comments/recipient lists in the frontend.
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
- 2026-07-14 (schema) — Replaced hand-applied `schema.sql` with
  `wrangler d1 migrations` (`migrations/0001_init.sql`), so future schema
  changes are additive and don't require wiping `memoza_notes`. See
  `backend-services/2-notes/CLAUDE.md`.
- 2026-07-14 — Folded pin into tags: dropped `note_grant.pinned` and
  `PATCH /notes/{id}/grant` (no per-grant field left to patch); pin is now the
  literal tag `"pin"`, saved through the normal `PUT /notes/{id}` path. Added
  unread-comment tracking (`note.last_comment_at`, `note_grant.last_viewed_at`)
  so `GET /notes` can return `has_unread_comment`; `GET /notes/{id}` now marks
  the note viewed as a side effect.
- 2026-07-10 (implemented) — Built `notes-service` against this README/table
  (the `IMPLEMENTATION-PLAN.md` had gone stale — still described folders and a
  grant `permission` column that this doc had already dropped on 2026-07-09;
  built to the README, not the plan). Added `note_grant.revoked_at` and the
  `sweep` bookkeeping table (not previously in `table.md`) to make tombstone/
  revoked propagation and the guarded lazy sweep concrete. Plan deleted.
- 2026-07-15 (design) — Added the notebook/pages feature: permanent per-owner
  `page_no` via a new `owner_page_seq` counter table, assigned only on create;
  client-side prev/next/jump navigation and deleted-page display need no new
  endpoints. Added opt-in public-page publishing: `POST /notes/{id}/publish`,
  a new plaintext `public_page` table keyed by `(owner_id, page_no)`, and an
  unauthenticated internal read endpoint composed by the gateway with the auth
  service's username resolver (see `docs/architecture/1-user-access-management/README.md`
  and the crypto spec's "Public pages"). Publishing is live-mirrored and has no
  unpublish path — only delete. Design only; not yet implemented (no migration
  added).
- 2026-07-15 (security review) — Hardened the publishing design: the live
  mirror is now explicitly client-supplied (`PUT` to a published note must
  carry plaintext `{title, body, format}`, `400` without them; plaintext on an
  unpublished note also `400`; tags never mirrored) — the server can't decrypt,
  so a server-side mirror was impossible as originally written. The gateway
  must validate `page_no`/`username` before composing internal URLs and return
  only the four public fields. Purge is one atomic batch (including the
  `public_page` delete); the lazy sweep also removes orphaned `public_page`
  rows; the mirror write is lifecycle-guarded against a racing trash/purge.
  `publish` returns `400` for a note with no `page_no`. Still design only.
- 2026-07-16 (design) — Minimized public responses: the anonymous page read
  returns exactly `{title, body, format}` (dropped `updated_at`); `publish`
  returns just `{page_no}`. Build plan for the whole notebook/publishing delta
  added at `backend-services/2-notes/IMPLEMENTATION-PLAN.md`.
- 2026-07-16 (implemented) — Built the notebook/publishing delta against this
  README/table: migration `0002_notebook.sql` (`note.page_no`, `note.is_public`,
  `owner_page_seq`, `public_page`); page numbers assigned via an atomic
  insert-if-missing + `UPDATE … RETURNING` bump on `PUT /notes/{id}` create
  only; `POST /notes/{id}/publish`; the update path's live mirror is a single
  guarded `UPDATE public_page … WHERE EXISTS (… note.rev = <new rev> AND
  is_public = 1 …)` in the same `batch()` as the content update, so it only
  applies when the paired note write actually succeeded (no read-then-write);
  the internal `GET /notes/internal/public/{owner_id}/{page_no}` read; and
  `public_page` cleanup (explicit purge, the sweep's lazy trash-expiry purge,
  and `purge-user`) all in the same atomic batch as the ciphertext blank, plus
  a bounded orphan sweep for rows whose note was hard-deleted. Verified against
  a local D1 instance: create/idempotent-replay keep the same `page_no`,
  publish → live read, mirror-required-once-published (`400` without it),
  plaintext-rejected-on-private (`400`), trash hides the public read, restore
  resumes it, purge removes the `public_page` row outright. Plan deleted.
