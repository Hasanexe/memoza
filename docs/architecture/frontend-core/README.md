# Shared Frontend Core — `frontend/core`

Platform-agnostic TypeScript shared by `frontend/web` and (later)
`frontend/desktop`. Holds the one audited crypto implementation, the API
clients, the `store` contract, and every view — so both shells run identical
code except for how they persist data and unlock. Crypto spec (algorithms, KDF
params, envelope formats): `docs/architecture/README.md`. Client state:
`table.md`.

## Component view

| Module | Responsibility |
|---|---|
| `crypto/codec.ts` | base64/hex/UTF-8 helpers, AES-GCM seal/open, generic AES-GCM and RSA-OAEP key wrap/unwrap primitives (IV-prefixed, base64 transport) |
| `crypto/kdf.ts` | `deriveMasterKey`, `deriveAuthHash`, `deriveWrapKey`, and the generic HKDF→AES-key derivation reused for both the login `wrapKey` and the two recovery-key-derived wrap keys |
| `crypto/keys.ts` | DEK / RSA keypair / recovery-key generation, export, wrap/unwrap under `wrapKey` or a recovery-derived key, and the extractable→non-extractable session-sealing step |
| `crypto/note.ts` | per-note `cek` generation; seal/open for title, body, tags (AAD = note id) and comments (AAD = comment id); wrap/unwrap `cek` under the DEK (owner) or an RSA public key (share) |
| `crypto/session.ts` | module-scoped, memory-only session state: `userId`, `email`, unwrapped `dek`/`privateKey` (non-extractable `CryptoKey`s), the access token, and the cached `wrappedDek`/`wrappedPrivateKey` ciphertext (see `table.md`) |
| `crypto/jwt.ts` | reads the access token's own claims (`user_id`) client-side — no signature verification (the server already verified it; the client only needs to know who it is) |
| `api/client.ts` | `fetch` wrapper: attaches the bearer token, single-flight `/auth/refresh` on 401, typed `ApiError` (status + parsed body) |
| `api/auth.ts`, `api/notes.ts` | typed functions mirroring `api-auth-usage.md` / `api-notes-usage.md` one-to-one; move ciphertext and wrapped-key strings only, no crypto here |
| `store/types.ts` | the `Store` **contract** every view codes against (`sync`, `listNotes`, `getNote`, `saveNote`, `setPinned`, trash/restore/purge, share/unshare, comments, `search`) — no persistence assumptions |
| `search.ts` | in-memory substring match over title + tags, given a plain list of `{id, title, tags}` |
| `views/*` | hash-routed screens (auth, list, editor, share dialog, settings) plus `dom.ts` (framework-free DOM builder) and `markdown.ts` (Markdown → sanitized HTML, lazy Mermaid) |

`frontend/web` supplies the in-memory `Store` implementation
(`frontend/web/src/store/memoryStore.ts`) and the Vite entry point; nothing
else. `frontend/desktop` will later supply a SQLite-backed offline `Store`
implementation behind the same interface — `crypto`, `api`, and `views` do not
change.

## Decisions

- **Extractable keys exist only transiently, never at rest.** A freshly
  generated `dek`/`privateKey`/`cek` must be extractable to produce its first
  wrapped copy (WebCrypto's `wrapKey` requires it), so each is converted to a
  non-extractable session copy immediately after (`sealDekForSession` etc.).
  Later operations that need to re-wrap an *existing* key (sharing a note to a
  new recipient, changing the password) cannot export the non-extractable
  session copy — instead they re-unwrap a fresh extractable copy from the
  already-known wrapped ciphertext (`unwrapCekWithDekExtractable`,
  `unwrapDekExtractable`, `unwrapPrivateKeyExtractable`), use it once, and
  discard it. This keeps the long-lived, XSS-exposed session state
  non-extractable while still supporting legitimate re-wrap flows. Rejected:
  keeping `dek`/`privateKey` extractable at rest (violates `SECURITY-RULES.md`
  directly).
- **`wrappedDek`/`wrappedPrivateKey` ciphertext is cached in session state**
  alongside the unwrapped keys, specifically to support the above — it's
  opaque server-issued ciphertext, not key material, so caching it carries
  none of the risk raw key bytes would. See `table.md`.
- **`views` live in `core`, not `web`** — the Tauri desktop shell renders the
  same DOM in a system WebView, so the UI code is exactly as reusable as
  `crypto`/`api`. Only the `store` implementation and the unlock mechanism
  (password vs. OS keystore) differ per shell.
- **One sanctioned `innerHTML` sink** (`views/markdown.ts`) — every other view
  builds DOM through `dom.ts`'s `h()` helper, so an XSS-via-note-content path
  can only exist in the one place that's DOMPurify-sanitized on every render.
- **`core` depends on Vite's `import.meta.env`** for build-time config
  (`VITE_API_BASE_URL`, `VITE_ESCROW_PUBLIC_KEY`) — acceptable because every
  consumer (web today, the Tauri shell later) builds with Vite; see
  `frontend/web`'s `variables.md`.

## Known gaps (accepted for v1)

- **No "list current participants" in the share dialog.** The notes API has
  no endpoint that enumerates a note's grants/participants (by design — see
  `docs/architecture/2-notes/README.md`), so the share dialog only supports
  share-by-email and revoke-by-email (which resolves the email to a user id
  via the same authenticated public-key lookup used for sharing). A future
  participants-listing endpoint would need a matching backend change.
- **`kdf_iterations` is a compile-time constant on the client**
  (`config.ts`), not fetched per-user before login. The server currently
  whitelists registration to exactly one value, so this doesn't bite yet, but
  it means a future per-user iteration bump wouldn't be usable by existing
  clients without also shipping a pre-login lookup (which the crypto spec
  deliberately avoided to prevent a user-enumeration surface). Documented, not
  built.

## Changes

- 2026-07-10 — Initial implementation: `crypto`, `api`, `store` interface,
  `search`, and all views built per `frontend/web/IMPLEMENTATION-PLAN.md`
  (now deleted). Extracted into `frontend/core` from the start so
  `frontend/desktop` can reuse it unchanged.
- 2026-07-10 (simplification + bugfix) — Register, password-change, and
  password-reset each re-implemented "derive credentials/wrap keys under a
  password" slightly differently; extracted `deriveCredential` (authHash +
  wrapKey from a password) and `buildPasswordEnvelope` (also wraps an existing
  `dek`/`privateKey`) into `crypto/keys.ts`, used by all three flows now. While
  unifying them, found that password-reset's confirm step unwrapped `dek`/
  `privateKey` as **non-extractable** and then tried to wrap them again for
  the new password — `crypto.subtle.wrapKey` requires the source key to be
  extractable, so this would have thrown at runtime. Fixed by unwrapping via
  the already-existing `unwrapDekExtractable`/`unwrapPrivateKeyExtractable`.
