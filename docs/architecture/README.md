# Memoza — System Overview

Memoza is a cross-platform note-taking app, organized as a **notebook**:
every note is also a permanently-numbered **page**. Notes are plain Markdown
(with Mermaid diagram support, and optional HTML), and the product competes on
**simplicity, performance, and privacy**: every note is end-to-end encrypted,
so the server — and its admins — can never read note content. Notes can be
**shared between Memoza users** while staying encrypted end-to-end (no
plaintext on the server, ever) — **with one deliberate, opt-in exception**: a
user may **publish** a page for anonymous public reading, which stores that
one page as plaintext (see the crypto spec's "Public pages" below).

- Product domain: `memoza.io`
- API host: `api.memoza.io` (Cloudflare Workers)
- Frontend host: `app.memoza.io` (online-only static web app); a Tauri
  desktop/mobile shell reusing the web crypto/api/store core adds offline-first
  and OS-keystore unlock (see `docs/architecture/frontend-desktop/README.md`)
- Platform: Cloudflare free tier (Workers, D1), per `CLOUDFLARE-RULES.md`

## Boundaries

| Module | Deployed name(s) | Responsibility |
|---|---|---|
| `1-user-access-management` | `memoza-auth`, `memoza-gateway` | Accounts, JWTs, refresh tokens, key envelopes (DEK + user keypair), password reset, account deletion, public-key lookup, permanent username handles; gateway verifies JWTs and routes to services (and composes the unauthenticated public-page read) |
| `2-notes` | `memoza-notes` | Encrypted notes, per-note key grants, read-only sharing, comments, shared tags, delta sync, trash, permanent page numbers, opt-in public page publishing |
| `3-subscriptions` | `memoza-billing` (planned) | Mobile in-app subscriptions (Apple/Google), server-verified with store notifications — see `docs/architecture/3-subscriptions/README.md` |
| `4-public-sites` | `memoza-sites` | `memozasites.com` — neutral, cookie-free origin serving published pages as standalone sites and the sandboxed runner that makes `format:html` notes interactive in-app — see `docs/architecture/4-public-sites/README.md` |
| `frontend/web` | app.memoza.io | Online-only UI, all cryptography, Markdown + Mermaid rendering, client-side search over title/tags |
| `frontend/desktop` | Tauri shell | Implemented scaffold — reuses the web crypto/api/store core; adds an offline-first local store and OS-keystore unlock |

Routing on `api.memoza.io` is split by path: `/auth/*` → `memoza-auth`,
everything else → `memoza-gateway`, which forwards `/notes/*` to `memoza-notes`
over a service binding and handles the authenticated public-key lookup.
`memoza-notes` has no public route and trusts identity only from the
gateway-set `X-User-Id` header — except that the gateway also answers
`GET /public/{username}/{page_no}` **unauthenticated** (like `/health`),
composing a username→user_id lookup in `memoza-auth` with a plaintext page
read in `memoza-notes` to serve a published page to anonymous visitors.

## End-to-end encryption — canonical spec

This section is the single source of truth for the crypto design. Other docs
reference it; they must not restate it.

**Principle: the server stores and transports ciphertext, public keys, and
opaque hashes only. The raw password, the master key, the personal DEK, the
user's private key, and every note key never leave the client in usable form.**

All primitives are WebCrypto-native (PBKDF2, HKDF, AES-256-GCM, RSA-OAEP-3072).
All binary values are transported/stored as base64.

### Per-user key material (created client-side at registration)

| Value | How it's made | Lives where |
|---|---|---|
| `masterKey` | `PBKDF2-SHA256(password, salt = SHA-256(lowercase email), 600,000 iters, 256 bit)` | Client memory only, transient |
| `authHash` | Derived from `masterKey` (PBKDF2, 1 iter, salt = utf8(password)), base64 | Sent as the `password` field; server PBKDF2-hashes it again before storing |
| `wrapKey` | `HKDF-SHA256(masterKey, info = "memoza-wrap", 256 bit)` | Client memory only, transient |
| `dek` | Random 256-bit AES-GCM key | Client session; server stores only wrapped forms. **Wraps the CEKs of notes the user owns** (fast symmetric bulk unwrap) |
| `keypair` | `RSA-OAEP-3072` (SHA-256) generated once | See below. **Used to receive shared notes** |
| `publicKey` | SPKI export of the keypair's public half | Server stores **in plaintext** (needed so others can share to this user) |
| `wrapped_private_key` | `AES-256-GCM(wrapKey, PKCS8(privateKey))` | Server (`users` row), returned at login |
| `wrapped_dek` | `AES-256-GCM(wrapKey, dek)` | Server (`users` row), returned at login |
| `recoveryKey` | Random 128-bit, shown to the user exactly once as grouped hex | User's responsibility (download/print) |
| `wrapped_dek_recovery` | `dek` wrapped by `HKDF(recoveryKey, "memoza-recovery-dek")` | Server (`users` row) |
| `wrapped_private_key_recovery` | `privateKey` wrapped by `HKDF(recoveryKey, "memoza-recovery-pk")` | Server (`users` row) |

The per-user KDF iteration count is stored server-side and returned at login so
it can be raised later without a lockstep client migration. The email-derived
salt means no pre-login salt endpoint is needed (no user-enumeration surface on
login). The **recovery key backs up both secrets** (dek *and* private key), so a
password reset can restore full access — own notes and shared-in notes alike.

### Per-note keys and grants

Notes are **not** encrypted with the DEK directly (that would make one note
unshareable without sharing all). Instead:

- Each note has its own random 256-bit **`cek`** (content encryption key).
- Title and body are encrypted with the `cek`: `AES-256-GCM`, fresh random
  96-bit IV per field, AAD = the note's `id`. Stored/transported as
  base64(iv ‖ ciphertext) in `title_ct` / `body_ct`. Titles are encrypted
  separately from bodies so list views never download bodies.
- Title, body, and **tags** are all note content encrypted with the `cek`
  (tags are `tags_ct`, an encrypted JSON array on the note). Because they share
  the `cek`, every participant can read the tags the owner set — tags are
  **shared, owner-authored** metadata, not a per-user label set.
- The `cek` is wrapped once **per participant**, and each wrapped copy is a
  **grant**:
  - **Owner grant** — `cek` wrapped by the owner's `dek` (symmetric, `wrap_method = "dek"`).
  - **Share grant** — `cek` wrapped by the recipient's `publicKey` (RSA-OAEP,
    `wrap_method = "pubkey"`).
- **Access = holding a grant.** To read, a client unwraps the `cek` from its
  own grant, then decrypts. Owner unwraps with the `dek` (fast); a share
  recipient unwraps with their `privateKey`.

### Sharing (read-only)

To share note X with `bob@memoza.io`: the owner's client looks up Bob's public
key (authenticated `GET /users/public-key`), wraps note X's `cek` to that
public key, and posts a share grant `{note_id, recipient_id, wrapped_cek}`. Bob
decrypts the `cek` with his private key and can **read** the note. **Only the
owner edits a note's content** (title/body/tags); the server authorizes writes
by `owner_id == caller`, so there is no multi-writer race and no per-grant
permission flag. Recipients contribute via **comments** (below), not edits.
Only the owner creates or revokes share grants.

### Comments

A note carries a thread of **comments** so read-only recipients can give the
owner feedback without editing. A comment's body is encrypted with the note's
`cek` (`AES-256-GCM`, AAD = the comment's `id`), so every participant — and only
participants — can read it. **Any participant** (owner or recipient) may post a
comment under their own `author_id`; the author or the owner may delete one.
Comments are note-level (no line/section anchoring in v1). Posting a comment
bumps the note's grants so the new activity surfaces in every participant's
sync.

### Per-user note metadata

The only **per-user** view of a note is `last_viewed_at` on the grant (drives
the unread-comment indicator; non-sensitive plaintext timestamp); everything
else about a note — content, tags, including the pin state (the tag `"pin"`)
— is shared. On the client, "My notes" vs "Shared with me" and tag filters
give each user their own organization without per-user server state.

### Account recovery & password reset (per-user mode)

There is an unavoidable cryptographic fork: **either the server has no way to
recover your keys, or it does.** A pure "email-only" reset that also restores
your *notes* is impossible without the server holding a recoverable copy of your
key — email can otherwise reset only your *login*, leaving the notes
undecryptable. So recovery is a **per-user choice made at registration**, stored
as `recovery_mode` on the user:

- **`private` (default) — true zero-knowledge.** The recovery key is shown once
  and never leaves the client. Reset requires it: email proves mailbox
  ownership, the recovery key unwraps `dek` + `privateKey`, the client re-wraps
  under the new password. Lose both password and recovery key ⇒ data is
  unrecoverable. This mode keeps the headline promise ("not even admins can read
  your notes") strictly true.
- **`convenient` (opt-in) — email-only reset, weaker.** The account is made
  server-recoverable by escrowing **one** blob: the recovery key itself,
  encrypted to a Memoza-held escrow key.

**How the recoverable copy is held (convenient mode):**

- Memoza operates an **escrow key pair**. `ESCROW_PUBLIC` is published to
  clients (it is public); `ESCROW_PRIVATE` is an **auth-worker secret** (secret
  store only, never in code/vars/logs) — the client never sees it.
- On opting in, the client stores `escrowed_recovery =
  RSA-OAEP(ESCROW_PUBLIC, recoveryKey)` on its `users` row. Nothing else is
  new: the DEK and private-key backups (`wrapped_dek_recovery`,
  `wrapped_private_key_recovery`) already exist — escrowing the recovery key
  just lets the server retrieve it on the user's behalf.
- **Reset flow:** the emailed token proves mailbox ownership; the server
  decrypts `escrowed_recovery` with `ESCROW_PRIVATE` and returns the recovery
  key to the now-verified client; the client then runs the **normal
  `private`-mode reset** — unwrap `dek` + `privateKey` from the recovery blobs,
  re-wrap under the new password, upload the new envelope. The server never
  learns the new `wrapKey`; it only hands back the recovery key, and the client
  does the re-wrap.
- **The cost, stated plainly in the UI:** whoever holds `ESCROW_PRIVATE` **and**
  the database can decrypt every convenient-mode user's notes — so this mode is
  **not zero-knowledge**. Mitigations: keep `ESCROW_PRIVATE` in a KMS/HSM (not a
  plain worker secret) once off the free tier; rate-limit and audit escrow
  decryptions; expose the capability only inside a verified reset. `private`
  users have no `escrowed_recovery` blob and stay fully zero-knowledge.

The mode is the user's informed tradeoff (fragility vs. convenience). Default is
`private` so the privacy guarantee holds unless a user explicitly downgrades.
Switching to `convenient` just uploads `escrowed_recovery`; switching back
deletes it. Notes are never touched either way.

### Server-visible metadata (accepted leak)

Note id, owner id, timestamps, revision, ciphertext sizes, participant user ids
(from grants), per-user `last_viewed_at` and the derived `has_unread_comment`
flag, per-comment author id / timestamp / size, and each owned note's `page_no`
(a per-owner sequence position, server-assigned — see the notes service design).
No note content, tag values (including the pin state and every other control
tag), or comment text are visible. Search runs client-side over decrypted data
— there is no server-side content index. The one exception is **published**
pages: for those, the plaintext title/body and the `format` value are
server-visible by definition (see "Public pages"); tags and comments stay
encrypted even then.

### Public pages (deliberate plaintext exception)

Everything above assumes the server only ever sees ciphertext. **Publishing a
page is the one deliberate exception**, and it's opt-in and explicit per page:

- The owner's client already holds the decrypted title/body (it has the
  `cek`), so "make public" just decrypts locally and uploads that plaintext —
  no key ever needs to reach an anonymous reader, and no key-in-URL scheme is
  needed. The **encrypted note stays the private source of truth**; the public
  copy is a separate, derived publication (the notes service's `public_page`
  row — see `docs/architecture/2-notes/README.md`).
- **Irreversible in effect, not just policy**: once plaintext has been served
  to any reader, it may already be cached/saved outside Memoza's control —
  there's no cryptographic way to claw it back. Consequently there is **no
  unpublish**; the only way to stop serving a page is to delete it (trash hides
  it, purge removes the `public_page` row for good), matching the UI warning
  shown before a user publishes. Public pages are served through a short edge
  cache (≤ 60 s TTL — quota/DoS protection, see `CLOUDFLARE-HARDENING.txt`),
  so "trash stops serving" means "within the cache TTL", not instantly.
- **Live mirror — the client re-uploads the plaintext on every edit**: the
  server cannot decrypt `title_ct`/`body_ct`, so once a note is published,
  every owner `PUT` update must carry plaintext `{title, body, format}`
  alongside the ciphertext fields and the server re-writes the public copy
  from them. A published-note update **without** the plaintext fields is
  rejected (`400`) so the mirror can never silently go stale; plaintext fields
  on an **unpublished** note are also rejected (`400`) so plaintext can never
  arrive for a private page. **Tags are never part of the plaintext** — they
  stay encrypted and unserved even on a published page. The public copy
  therefore always matches the current content until the page is deleted.
  There is no frozen-snapshot mode.
- The public URL (`https://memozasites.com/<username>/<page_no>`, served by
  the `memoza-sites` worker as a standalone site) resolves through an
  **unauthenticated** composition that spans two services — username →
  user id in `memoza-auth`, then page content in `memoza-notes` — composed by
  the gateway and consumed by `memoza-sites` over a service binding. See
  `docs/architecture/4-public-sites/README.md` and the notes and auth service
  designs for the endpoints.
- **This is the one path where "not even admins can read your notes" is
  knowingly false** — for that specific page, once published. The UI must say
  so in plain language before the user confirms.

### Consequences (accepted)

- **In `private` mode, forgetting the password with no recovery key = permanent
  data loss.** The UI must say this at registration; `convenient` mode trades
  this safety for a weaker privacy guarantee (see recovery mode above).
- **Password change / reset is cheap**: unwrap `dek` + `privateKey` (with the
  old `wrapKey` on change, or with the recovery key on reset), re-wrap under the
  new `wrapKey`, upload the new `wrapped_dek` + `wrapped_private_key` +
  `authHash`. Notes and grants are untouched.
- **Sharing reveals membership**: the public-key lookup tells the requester
  whether an email belongs to a Memoza user. Standard and unavoidable for E2EE
  sharing; the endpoint is authenticated to limit it to logged-in users.
- **Revocation is soft**: removing a grant stops future access, but a recipient
  who already cached the `cek`/plaintext keeps it (and could still read later
  content or comments under that `cek`). True revocation would require rotating
  the `cek` and re-wrapping for remaining participants — out of scope for MVP
  (documented, not built).
- **Publishing a page is a deliberate, opt-in plaintext exception** to the
  whole model above, scoped to exactly the pages an owner chooses to publish —
  see "Public pages" above.
- Password strength **cannot** be enforced server-side (it never sees the
  password), so the client owns the only rule — **minimum 10 characters** — and
  the server just guards that the `authHash` field is a non-empty string within a
  length cap. No character-class rules. (A tampered client could bypass the
  client rule, but that only weakens that user's own notes, which the server
  can't protect in E2EE anyway.)

## End-to-end flows

- **Register**: client derives `authHash`, generates `dek`, `keypair`, and
  `recoveryKey`; sends `email, name, password = authHash, kdf_iterations,
  public_key, wrapped_dek, wrapped_private_key, wrapped_dek_recovery,
  wrapped_private_key_recovery`; shows the recovery key once. The response is
  **always a generic 202 "check your email"** (new email → activation link;
  existing email → a "you already have an account" mail) so registration
  leaks no account existence. The account stays **inactive** (login refused)
  until the emailed activation link is used — and the activation step is
  where the user picks their permanent public `username` (page links,
  sharing). `username` never participates in login or key derivation, only
  `email` does. See the auth service design for the activation flow.
- **Login**: client derives `authHash`, posts it; response includes tokens plus
  `wrapped_dek`, `wrapped_private_key`, `kdf_iterations`; client unwraps both.
- **Create note**: client generates a `cek`, encrypts title/body/tags, wraps
  `cek` with its `dek`; posts note + owner grant.
- **Share**: owner looks up recipient public key, wraps `cek`, posts a
  (read-only) share grant.
- **Read**: any participant unwraps `cek` from its grant and decrypts. **Edit**:
  only the owner re-encrypts title/body/tags with the same `cek`.
- **Comment**: any participant encrypts a comment body with the note's `cek` and
  posts it; the write bumps the note's grants so it surfaces in every
  participant's sync.
- **Sync**: clients page a keyset cursor (`?since=`) over their grants (writes —
  including comments — bump every grant of the note), plus tombstones/revoked;
  owner content writes use a client-generated id + `rev` compare-and-swap and get
  `409` on conflict (owner multi-device only; resolved by keep-both). See the
  notes service design.
- **Password change**: `PUT /auth/password` with old/new `authHash` and new
  `wrapped_dek` + `wrapped_private_key`; all refresh tokens revoked.
- **Password reset**: `POST /auth/reset/request` emails a token. In `private`
  mode the user supplies their own recovery key; in `convenient` mode the server
  decrypts `escrowed_recovery` and returns the recovery key to the verified
  client. Either way the client unwraps `dek` + `privateKey` from the recovery
  blobs, re-wraps under the new password, and `POST /auth/reset/confirm` uploads
  the token, new `authHash`, and new wrapped blobs; all sessions revoked.
- **Account deletion**: `DELETE /auth/account` removes the user and fans out to
  `memoza-notes` (service binding) to purge that user's notes, grants, and
  comments.

## Principles

- Simplicity beats features: Markdown (+ optional HTML) notes, pin, trash,
  shared tags, client-side search, read-only sharing, comments, permanent page
  numbers, and opt-in public publishing — nothing speculative. No folders, no
  rich-text editor, no attachments, no note-version history in v1.
- The **web** client is online-only (memory-only keys and data); **offline-first
  and OS-keystore unlock are the Tauri desktop/mobile shell's job**, reusing the
  same crypto/api/store core.
- Workers are thin control planes storing opaque blobs; all heavy lifting
  (crypto, rendering, search, offline queueing) runs on the client.
- Free-tier native: D1 + service bindings, zero runtime dependencies beyond
  `jose` (auth/gateway only).

## Doc map

| Doc | Home |
|---|---|
| Auth + gateway design | `docs/architecture/1-user-access-management/README.md` + `table.md` + `variables.md` |
| Notes service design | `docs/architecture/2-notes/README.md` + `table.md` + `variables.md` |
| Subscriptions design (planned) | `docs/architecture/3-subscriptions/README.md` + `table.md` + `variables.md` |
| Public sites design (`memozasites.com`) | `docs/architecture/4-public-sites/README.md` + `variables.md` (no `table.md` — the service has no database) |
| Cloudflare-dashboard hardening checklist | `CLOUDFLARE-HARDENING.txt` (repo root — panel-only items, not code) |
| Shared frontend core design (`crypto`/`api`/`store`/`views`) | `docs/architecture/frontend-core/README.md` + `table.md` |
| Web frontend design | `docs/architecture/frontend-web/README.md` + `table.md` + `variables.md` |
| Desktop/mobile (Tauri) design | `docs/architecture/frontend-desktop/README.md` + `table.md` + `variables.md` |
| Auth API guide (frontend integration) | `docs/api/api-auth-usage.md` |
| Notes API guide (frontend integration) | `docs/api/api-notes-usage.md` |
| Build scaffolds (ephemeral) | `IMPLEMENTATION-PLAN.md` inside each unbuilt module folder |
