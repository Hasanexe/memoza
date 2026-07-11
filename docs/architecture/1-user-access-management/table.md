# Data Model — `memoza_auth` (D1)

One database, owned exclusively by `memoza-auth`. Envelope/format definitions
are in the canonical crypto spec (`docs/architecture/README.md`).

## `users`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `email` | TEXT UNIQUE NOT NULL | Stored lowercase |
| `name` | TEXT NOT NULL | Display name |
| `password_hash` | TEXT NOT NULL | `pbkdf2$<iterations>$<b64 salt>$<b64 hash>` of the client `authHash`, PBKDF2-SHA256 server-side (16-byte salt, 256-bit output); verified with `timingSafeEqual` |
| `role` | TEXT NOT NULL DEFAULT 'Editor' | Single role for now |
| `created_at` | INTEGER NOT NULL | Unix ms |
| `active` | INTEGER NOT NULL DEFAULT 1 | 0 = disabled account |
| `kdf_iterations` | INTEGER NOT NULL | Client-side PBKDF2 iteration count (600,000) |
| `public_key` | TEXT NOT NULL | base64 SPKI RSA-OAEP-3072 public key — **plaintext**, used to wrap note keys to this user |
| `wrapped_dek` | TEXT NOT NULL | DEK wrapped by the password-derived `wrapKey`; opaque to the server |
| `wrapped_private_key` | TEXT NOT NULL | Private key wrapped by `wrapKey`; opaque to the server |
| `wrapped_dek_recovery` | TEXT | DEK wrapped by the recovery-key-derived key; opaque |
| `wrapped_private_key_recovery` | TEXT | Private key wrapped by the recovery-key-derived key; opaque |
| `recovery_mode` | TEXT NOT NULL DEFAULT 'private' | `private` (zero-knowledge) or `convenient` (server-recoverable via escrow) — see crypto spec |
| `escrowed_recovery` | TEXT | `convenient` mode only: recovery key encrypted to `ESCROW_PUBLIC` (server can decrypt with the `ESCROW_PRIVATE` secret). NULL in `private` mode |

## `refresh_tokens`

| Column | Type | Notes |
|---|---|---|
| `token_hash` | TEXT PK | SHA-256 of the raw token — raw value never stored |
| `user_id` | TEXT NOT NULL → users.id | |
| `expires_at` | INTEGER NOT NULL | Unix ms; expired rows lazily purged on refresh |

Index: `idx_refresh_tokens_user` on `(user_id)` — revoke all sessions on
password change/reset.

## `reset_token`

| Column | Type | Notes |
|---|---|---|
| `token_hash` | TEXT PK | SHA-256 of the raw emailed token — raw value never stored |
| `user_id` | TEXT NOT NULL → users.id | |
| `expires_at` | INTEGER NOT NULL | Unix ms; single-use, deleted on confirm, lazily purged |

Index: `idx_reset_token_user` on `(user_id)`.
