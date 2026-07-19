# Data Model — `memoza_auth` (D1)

One database, owned exclusively by `memoza-auth`. Envelope/format definitions
are in the canonical crypto spec (`docs/architecture/README.md`).

## `users`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `email` | TEXT UNIQUE NOT NULL | Stored lowercase. Login + KDF salt + reset — unaffected by `username` |
| `username` | TEXT UNIQUE | Permanent public handle, **NULL until activation** (picked in `POST /auth/activate`, immutable after — no rename path). Stored lowercase; 3–32 chars, `[a-z0-9-]`, no leading/trailing hyphen (case-insensitive uniqueness — `Ada` = `ada`). Used for public page links, `.mmp`/`memoza://` shortcuts, and optionally sharing — never for login or key derivation. On account deletion the value moves to `retired_usernames` |
| `name` | TEXT NOT NULL | Display name |
| `password_hash` | TEXT NOT NULL | `pbkdf2$<iterations>$<b64 salt>$<b64 hash>` of the client `authHash`, PBKDF2-SHA256 server-side (16-byte salt, 256-bit output); verified with `timingSafeEqual` |
| `role` | TEXT NOT NULL DEFAULT 'Editor' | Single role for now |
| `created_at` | INTEGER NOT NULL | Unix ms |
| `active` | INTEGER NOT NULL DEFAULT 0 | 0 = registered but not yet activated (login refused with `403 "Not activated"` on correct credentials, invisible to `resolve-username`); 1 = activated. Set by `POST /auth/activate`. Inactive rows older than `UNACTIVATED_RETENTION_MS` are lazily deleted during register |
| `kdf_iterations` | INTEGER NOT NULL | Client-side PBKDF2 iteration count (600,000) |
| `public_key` | TEXT NOT NULL | base64 SPKI RSA-OAEP-3072 public key — **plaintext**, used to wrap note keys to this user |
| `wrapped_dek` | TEXT NOT NULL | DEK wrapped by the password-derived `wrapKey`; opaque to the server |
| `wrapped_private_key` | TEXT NOT NULL | Private key wrapped by `wrapKey`; opaque to the server |
| `wrapped_dek_recovery` | TEXT | DEK wrapped by the recovery-key-derived key; opaque |
| `wrapped_private_key_recovery` | TEXT | Private key wrapped by the recovery-key-derived key; opaque |
| `recovery_mode` | TEXT NOT NULL DEFAULT 'private' | `private` (zero-knowledge) or `convenient` (server-recoverable via escrow) — see crypto spec |
| `escrowed_recovery` | TEXT | `convenient` mode only: recovery key encrypted to `ESCROW_PUBLIC` (server can decrypt with the `ESCROW_PRIVATE` secret). NULL in `private` mode |

## `retired_usernames`

Usernames that can never be registered (or re-registered). Consulted, together
with `users.username`, by both `POST /auth/register` and
`GET /auth/username-available`. Rows come from two sources: **account
deletion** (the deleted user's handle moves here so old public links can never
resolve to a different person) and a **seeded reserved list** of
system/product words.

| Column | Type | Notes |
|---|---|---|
| `username` | TEXT PK | Lowercase |
| `reason` | TEXT NOT NULL | `deleted` or `reserved` |
| `retired_at` | INTEGER NOT NULL | Unix ms (seed rows: migration time) |

Seeded reserved words (extend before launch as new product surfaces appear):

`admin administrator root system support help contact info abuse security
postmaster webmaster mail email noreply no-reply memoza official staff team
moderator mod api app www web auth login logout register signup signin account
accounts user users username profile settings password reset verify activate
activation token oauth internal gateway health status public private share
shared note notes page pages notebook tag tags trash archive search sync
comment comments publish editor new create delete edit home index dashboard
about terms privacy legal policy pricing billing payment subscribe
subscription pro premium free trial blog docs documentation faq news download
downloads static assets fonts images img media css js cdn favicon robots
sitemap anonymous guest test demo example null undefined true false`

(Words containing `.` — `favicon.ico`, `robots.txt`, `.well-known`, file
names — are already unregistrable via the charset rule and need no seed row.)

## `refresh_tokens`

| Column | Type | Notes |
|---|---|---|
| `token_hash` | TEXT PK | SHA-256 of the raw token — raw value never stored |
| `user_id` | TEXT NOT NULL → users.id | |
| `expires_at` | INTEGER NOT NULL | Unix ms; expired rows lazily purged on refresh |

Index: `idx_refresh_tokens_user` on `(user_id)` — revoke all sessions on
password change/reset.

## `activation_token`

Single-use token behind the registration activation link (see the README's
"Registration & activation"). Also the credential that gates
`GET /auth/username-available` (a pending registrant has no JWT yet).

| Column | Type | Notes |
|---|---|---|
| `token_hash` | TEXT PK | SHA-256 of the raw emailed token — raw value never stored |
| `user_id` | TEXT NOT NULL → users.id | The inactive account this activates |
| `expires_at` | INTEGER NOT NULL | Unix ms (`ACTIVATION_TOKEN_TTL_MS`); single-use, deleted on activate, lazily purged |

Index: `idx_activation_token_user` on `(user_id)` — replace the pending token
when the same email re-registers.

## `reset_token`

| Column | Type | Notes |
|---|---|---|
| `token_hash` | TEXT PK | SHA-256 of the raw emailed token — raw value never stored |
| `user_id` | TEXT NOT NULL → users.id | |
| `expires_at` | INTEGER NOT NULL | Unix ms; single-use, deleted on confirm, lazily purged |

Index: `idx_reset_token_user` on `(user_id)`.
