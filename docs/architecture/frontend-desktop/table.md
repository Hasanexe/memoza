# Client State — desktop shell (SQLite)

Local, per-device SQLite database (`memoza.db`, via `tauri-plugin-sql`).
Mirrors the server shape — **ciphertext and wrapped keys only**, same trust
boundary as D1. Envelope/format definitions: the canonical crypto spec
(`docs/architecture/README.md`). Shared in-memory session fields (unwrapped
`dek`/`privateKey`, access token): `docs/architecture/frontend-core/table.md`
— unchanged on desktop.

## `local_note`

Local cache of every synced note (not just opened ones — full-body search
needs the body available offline). One row per note the user can currently
see.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Same id as the server's `note.id` |
| `owner_id` | TEXT | |
| `title_ct`, `body_ct`, `tags_ct` | TEXT | Same ciphertext as the server; `tags_ct` nullable |
| `wrapped_cek` | TEXT | This user's grant |
| `wrap_method` | TEXT | `dek` / `pubkey` |
| `has_unread_comment` | INTEGER | Mirrors the server's derived flag; pin is just the tag `"pin"` inside `tags_ct`, no separate column |
| `page_no` | INTEGER, nullable | Permanent per-owner page number; `NULL` until a queued `create` op drains and the server assigns one. Mirrors the server's `note.page_no` |
| `is_public` | INTEGER | Mirrors `note.is_public`; when `1`, the write queue attaches the plaintext mirror fields to a drained `update` op (see `write_queue`) |
| `rev` | INTEGER | Used to skip re-fetching the body when only the grant changed (e.g. a comment's unread state) |
| `created_at`, `updated_at`, `deleted_at` | INTEGER | Mirrors the server row |

## `local_comment`

Cached comment ciphertext per note, refreshed opportunistically (best-effort
network fetch on `listComments`, falling back to whatever's cached when
offline).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `note_id` | TEXT | |
| `author_id` | TEXT | |
| `body_ct` | TEXT | |
| `created_at` | INTEGER | |

## `sync_state`

Single row holding the persisted keyset cursor (unlike the web shell, where
the cursor lives only in memory for the session).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Always `1` |
| `cursor` | TEXT | Opaque `next` cursor from the last `GET /notes` page; `NULL` = full resync next time |

## `write_queue`

Durable queue of mutations pending sync, drained FIFO. Draining stops after
the first failure and resumes on the next trigger (enqueue, `online`,
`visibilitychange`) **or** a 15s backoff timer scheduled by that same
failure (`queue.ts`). Survives app restarts and offline periods.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Queue entry id (not a note/comment id) |
| `kind` | TEXT | `create` / `update` / `trash` / `restore` / `purge` / `share` / `unshare` / `comment` / `deleteComment` |
| `note_id` | TEXT | Nullable (present for all current kinds) |
| `payload_json` | TEXT | The operation's ciphertext/args — never plaintext. An `update` op also carries `isPublic`; if true, `applyOp` decrypts the queued ciphertext with the note's `cek` **at drain time** and attaches the plaintext mirror fields `{title, body, format}` to the outbound `PUT` — plaintext is never written into this column |
| `created_at` | INTEGER | FIFO order |
| `attempts` | INTEGER | Incremented on failure; draining stops after any failure (retried next drain) |
| `last_error` | TEXT | Last failure message, for diagnostics only — never logs secrets |

## `local_account`

Single row: the current user's cached envelope, enabling both passwordless
unlock and offline **password** unlock (`getLocalAccountFor()`) — no network
call needed to re-fetch `wrapped_dek`/`wrapped_private_key` on a fresh launch,
as long as this device has signed in online at least once.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Always `1` |
| `user_id`, `email`, `username` | TEXT | |
| `wrapped_dek`, `wrapped_private_key` | TEXT | Ciphertext, opaque — **not** key material |
| `locked` | INTEGER | `1` after the **Lock** button; suppresses passwordless auto-unlock until the next password sign-in. Set by `lockDevice()`, cleared by `sealDeviceUnlock()` |

## OS keystore (outside SQLite)

Two secrets, sealed via the `keyring` crate (Windows Credential Manager /
macOS Keychain / Linux Secret Service), service `io.memoza.desktop`:

- account `wrapkey` — the raw `wrapKey` bytes (HKDF output, base64), used to
  unwrap the cached envelope.
- account `authhash` — the login `authHash` (base64), used by `ensureOnline()`
  to silently re-obtain an access token without the password. Decrypts nothing;
  authenticates only to the zero-knowledge server.

Neither is ever in SQLite or logged. Both are cleared on logout
(`clearLocalAccount`) and on account switch.
