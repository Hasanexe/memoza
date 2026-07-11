# Client State — web app

The web client is **online-only and memory-only**: no note content, ciphertext,
wrapped key, or unwrapped key is ever persisted. Everything below the first
section lives only in memory for the session and is gone on tab close or reload.
Envelope/format definitions: the canonical crypto spec
(`docs/architecture/README.md`).

## Persisted (non-secret only)

| Store | Key | Value |
|---|---|---|
| `localStorage` | `user_email` | Last email, to prefill the lock screen and derive the KDF salt. Non-secret; the only thing that survives a reload |
| `localStorage` | `theme` | `light` / `dark` toggle (optional; else `prefers-color-scheme`) |

No access token, no refresh token (the refresh token is an httpOnly cookie set
by auth), and no key material are persisted. On reload the app re-authenticates
via the cookie and shows the lock screen for the password.

## In-memory session state (never persisted)

| Value | Notes |
|---|---|
| `dek` | Non-extractable AES-GCM `CryptoKey` (unwrap/decrypt) |
| `privateKey` | Non-extractable RSA-OAEP private `CryptoKey` (decrypt) |
| `access_token` | Current JWT (15 min), refreshed via the cookie |
| `notes` | Synced list rows (ciphertext + `wrapped_cek` + `pinned`), plus bodies/comments for opened notes |
| `notes_cursor` | Keyset `next` cursor for the session's incremental sync |
| `search_index` | Plaintext title + tags index built from the synced rows (no bodies) |
