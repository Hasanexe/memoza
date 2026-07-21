# Client State — `frontend/core`

Envelope/format definitions: the canonical crypto spec
(`docs/architecture/README.md`). This table covers state `core` itself owns;
`frontend/web`'s `table.md` covers the web shell's `store` cache on top of
this.

## Persisted (owned by `core/views`, non-secret only)

| Store | Key | Value |
|---|---|---|
| `localStorage` | `user_email` | Last email, to prefill the lock screen and derive the KDF salt. Non-secret |
| `localStorage` | `theme` | `light` / `dark` override; absent = follow `prefers-color-scheme` |
| `localStorage` | `memoza_language` | UI language code (`i18n/languages.ts`'s `LANGUAGES`); absent = browser-detected. Mirrors the account's server-side `language` once signed in (`docs/architecture/1-user-access-management/README.md`'s `table.md`) |

No access token, no refresh token (httpOnly cookie, set by `memoza-auth`), and
no key material are ever persisted by `core`.

## In-memory session state (`crypto/session.ts`, module-scoped, never persisted)

| Field | Type | Notes |
|---|---|---|
| `userId` | `string` | Read from the access token's own `user_id` claim (`crypto/jwt.ts`), not verified client-side — the server already verified it |
| `email` | `string` | Cached for KDF salt derivation on subsequent operations (password change, etc.) |
| `username` | `string` | The account's permanent public handle (set at activation), returned by `POST /auth/login`; used to build a published page's shareable link (`views/shareView.ts`'s `publicPageUrl`) |
| `dek` | `CryptoKey` (AES-GCM, non-extractable) | Unwraps owner-side note `cek`s |
| `privateKey` | `CryptoKey` (RSA-OAEP-3072, non-extractable) | Unwraps share-side note `cek`s |
| `wrappedDek` | `string` (base64 ciphertext) | The *current* `wrapped_dek` from the server, cached so password-change can re-unwrap a transient extractable copy without a network round trip. Opaque ciphertext, not key material |
| `wrappedPrivateKey` | `string` (base64 ciphertext) | Same, for the private key |
| access token | `string` | Held in a separate module-level variable (`getAccessToken`/`setAccessToken`); 15 min lifetime, refreshed via the httpOnly cookie |

`lock()` clears `dek`/`privateKey`/`userId`/`email`/wrapped-envelope fields
(used on a reload — the app re-authenticates via the refresh cookie and
re-prompts for the password). `logout()` additionally clears the access
token.
