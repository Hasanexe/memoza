# Notes API — Frontend Integration Guide

Base URL: `https://api.memoza.io` (routed through the gateway; send the Bearer
access token on every call). All bodies JSON; errors `{ "error": "message" }`.
Auth, tokens, and the public-key lookup are in `api-auth-usage.md`.

**The server stores ciphertext and wrapped keys only.** You encrypt before
sending and decrypt after receiving. Field formats (CEK, `title_ct`/`body_ct`,
`tags_ct`, `wrapped_cek`) are defined in the canonical crypto spec.

## Concepts

- Each note has its own **CEK**. You generate it on create, encrypt
  title/body/tags with it, and send it **wrapped by your DEK** as `wrapped_cek`.
- **Tags are shared note content** (a `tags_ct` on the note, CEK-encrypted) —
  every participant sees them, and only the owner edits them. **Pinning is
  just the tag `"pin"`** — there's no separate pin field or endpoint; save it
  through `tags_ct` like any other tag.
- **Only the owner edits a note's content.** If you hold a share grant you can
  read the note and add comments, but not edit title/body/tags.
- **You generate the note `id`** (a UUID) client-side and create/update via
  `PUT /notes/{id}`. This makes offline replay idempotent — retrying a create
  after a lost response can't produce a duplicate.
- Sync is one keyset-paginated endpoint. The `since` cursor is an opaque string
  the server returns; store it and pass it back. Page until `next` is null.
- Every note you own gets a permanent **`page_no`** on create, assigned by the
  server (never reused, never client-set). Prev/next/jump-to-page navigation is
  just sorting your already-synced owned notes by this field — no endpoint.
- A note can be **published** (`POST /notes/{id}/publish`) for anonymous public
  reading. This uploads plaintext and is a one-way door — see "Pages & public
  sharing" below.

## `GET /notes` — list / delta sync (single endpoint)

`GET /notes` (full sync) or `GET /notes?since=<cursor>` (changed only),
optionally `&limit=<n>` (server clamps to `MAX_SYNC_LIMIT`). `200` →

```json
{
  "notes": [
    {
      "id": "…", "owner_id": "…", "title_ct": "…", "tags_ct": null,
      "wrapped_cek": "…", "wrap_method": "dek",
      "has_unread_comment": false, "page_no": 26, "is_public": false,
      "rev": 3, "created_at": 0, "updated_at": 0, "deleted_at": null
    }
  ],
  "tombstones": ["<note id>", "…"],
  "revoked": ["<note id>", "…"],
  "next": "<cursor|null>"
}
```

Never includes `body_ct`. `tombstones` = notes purged server-side; `revoked` =
notes unshared from you. `has_unread_comment` is true when a comment landed
after you last opened the note (`GET /notes/{id}`) — it clears the next time
you open it. `page_no` is only meaningful for notes you own (null on notes
shared with you — they aren't part of your own page sequence). Keep calling
with `since=next` until `next` is null, then persist the final `next` as your
cursor for the next sync. A note whose content changed (even by another
participant) reappears here because writes touch every grant of the note.

## `GET /notes/{id}` — full note

`200` → the list shape plus `body_ct`. Decrypt: unwrap `wrapped_cek` (with your
DEK if `wrap_method="dek"`, else your private key), then AES-GCM-decrypt
`title_ct`/`body_ct` (AAD = note id). `404` if you have no grant. As a side
effect this marks the note viewed (clears `has_unread_comment` for you).

## `PUT /notes/{id}` — create or update (idempotent, owner only)

Generate the `id` and a CEK, encrypt title/body/tags, wrap the CEK with your DEK.

**Create** (id not seen before) — omit `base_rev`:

```json
{ "title_ct": "…", "body_ct": "…", "tags_ct": "<base64|null>", "wrapped_cek": "…" }
```

`201` → `{ "id": "…", "rev": 1, "created_at": 0, "updated_at": 0, "page_no": 27 }`
and your owner grant (`wrap_method="dek"`). Re-sending the same create returns
the existing note unchanged (no duplicate) — including the same `page_no`.

**Update** — send `base_rev` (the rev you edited from); **owner only**, re-use
the **same** CEK:

```json
{ "title_ct": "…", "body_ct": "…", "tags_ct": "<base64|null>", "base_rev": 3 }
```

**If the note is published** (`is_public: true`), also include the plaintext
mirror fields — the server can't decrypt, so you supply the public copy with
every save:

```json
{ "title_ct": "…", "body_ct": "…", "tags_ct": "<base64|null>", "base_rev": 3,
  "title": "…", "body": "…", "format": "md" }
```

`400` if a published-note update omits them, and `400` if you send them for an
unpublished note. Tags are never sent in plaintext — they stay encrypted even
on published pages.

`200` → `{ "rev": 4, "updated_at": 0 }`. `409` → `{ "error": "Conflict",
"note": { …current row incl. body_ct… } }`: resolve keep-both (save your losing
version as a new note you own — only your own devices can conflict). `403` if
you are not the owner.

## Comments

Any participant (owner or share recipient) can read and post comments; the body
is encrypted with the note's CEK (AAD = the comment `id`).

- `GET /notes/{id}/comments` → `{ "comments": [ { "id", "author_id", "body_ct",
  "created_at" } ] }`, oldest first. `404` if you have no grant.
- `POST /notes/{id}/comments` — generate the comment `id` (UUID), encrypt the
  body with the note's CEK: `{ "id": "…", "body_ct": "…" }` → `201`. Idempotent
  on replay. Posting bumps the note so it resurfaces in every participant's sync.
- `DELETE /notes/{id}/comments/{comment_id}` → `200`. Allowed for the comment
  author or the note owner; else `403`.

## Trash lifecycle (owner only)

- `DELETE /notes/{id}` → `200`, moves to trash (`deleted_at` set).
- `POST /notes/{id}/restore` → `200`, un-trash.
- `DELETE /notes/{id}/purge` → `200`, permanent; becomes a tombstone for all
  participants. Non-owners calling these get `403`.

## Sharing (owner only)

First fetch the recipient's key (`GET /users/public-key`, see
`api-auth-usage.md`), wrap this note's CEK to it, then:

`POST /notes/{id}/share`

```json
{ "recipient_id": "…", "wrapped_cek": "<RSA-OAEP wrapped>" }
```

`200`/`201` — shares are read-only. `DELETE /notes/{id}/share/{user_id}` →
`200`, revokes the grant (the note appears in that user's `revoked` list on next
sync). Re-sending `share` for an existing recipient re-wraps their CEK.

## Pages & public sharing

**Publishing uploads plaintext.** Unlike every other endpoint in this guide,
`publish` sends decrypted content — you already hold it (you have the `cek`).
This is a deliberate, one-way exception to "the server never sees plaintext";
show the user a warning before calling it (see the crypto spec's "Public
pages"). **Owner only.**

`POST /notes/{id}/publish`

```json
{ "title": "…", "body": "…", "format": "md" }
```

`200`/`201` → `{ "page_no": 26 }` (all you need to build the link). `400` if
the note has no `page_no` yet (legacy note predating pages, not yet
backfilled). The public URL is
`https://app.memoza.io/<your username>/<page_no>`. **There is no unpublish
endpoint** — the public copy stays live; after publishing, every `PUT` update
must carry the plaintext mirror fields (see `PUT /notes/{id}` above), which is
how the public copy stays current — no need to call `publish` again. Only the
title and body are ever public; tags stay encrypted. The only way to stop
serving the page is `DELETE /notes/{id}` (trash — immediately stops serving
it, restorable — note that **restoring resumes public serving**, so the
restore UI warns for published notes) or `DELETE /notes/{id}/purge`
(permanent).

**Reading a public page** is a separate, unauthenticated endpoint, not part of
the note/grant API above: `GET https://api.memoza.io/public/<username>/<page_no>`
→ `200` → `{ "title": "…", "body": "…", "format": "md" }` (exactly these three
fields, nothing else), or `404` if unpublished/deleted/no such username. No
token, no encryption, no `cek` involved — the frontend's public reader page
(`app.memoza.io/<username>/<page_no>`) just calls this and renders the result.
See `api-auth-usage.md` for how usernames resolve.

## Status codes

`200` ok · `201` created · `400` validation · `401` unauthorized (refresh &
retry) · `403` permission · `404` no grant / not found · `409` edit conflict.
