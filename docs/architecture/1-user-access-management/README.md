# User Access Management — `memoza-auth` + `memoza-gateway`

Authentication, key-envelope storage, and routing layer for Memoza. Two
Cloudflare Workers sharing the `api.memoza.io` host by path. Data model:
`table.md`. Crypto spec (keys, KDF, envelope formats, grants): the canonical
spec in `docs/architecture/README.md` — not restated here.

## Components

| Worker | Route | Role |
|---|---|---|
| `memoza-auth` | `api.memoza.io/auth/*` | Registration, login, refresh, logout, password change, password reset, account deletion; owns D1 `memoza_auth`, the JWT **private** key, and every user's key envelope + public key |
| `memoza-gateway` | `api.memoza.io/*` (everything else) | Verifies EdDSA access JWTs (against the current + optional previous **public** key, for zero-downtime rotation), answers `/health` and `/public/*` unauthenticated, strips inbound `Authorization`/`X-User-Id`/`X-User-Role`, attaches a trusted `X-User-Id`, forwards `/notes/*` to `memoza-notes` over a service binding; also serves the authenticated public-key lookup and composes the public-page read (`username` → `memoza-auth`, page content → `memoza-notes`) |

Access tokens: EdDSA JWTs, 15 min, claims `user_id` + `username`. The gateway
verifies the token and forwards both as `X-User-Id` / `X-Username` to upstream
services (stripping any client-supplied copies first), so downstream workers get
a trusted, spoof-proof username without a lookup. Refresh tokens: 32 random
bytes, rotated on every refresh,
stored as SHA-256 hash only, delivered via
`__Secure-refresh_token; HttpOnly; Secure; SameSite=Strict; Path=/auth`.

The auth service stores each user's **key envelope** (wrapped DEK, wrapped
private key, public key, both recovery blobs) because it is tied to the
credential lifecycle — it changes exactly when credentials change (register,
password change, reset), keeping those updates a single transaction in one
service.

## Endpoint map

| Endpoint | Purpose | Status |
|---|---|---|
| `GET /auth/username-available?username=&token=` | Requires a valid, unexpired **activation token** (no JWT exists yet at activation time — the token is the proof of a pending registration, so this is not an open public endpoint). Generic `{ "available": true|false }` — never reveals *why* unavailable (taken vs reserved vs retired) | Implemented |
| `POST /auth/register` | Store key envelope + public key for an **inactive** account (no username yet). **Always a generic `202`** whether or not the email exists: new email → activation link mailed; existing email → "you already have an account" mailed. No tokens returned; no enumeration surface | Implemented |
| `POST /auth/activate` | `{token, username}` from the emailed activation link: validates the token, claims the username (generic `409` if unavailable — pick another), sets `active=1`, deletes the token. The user then logs in normally | Implemented |
| `POST /auth/login` | Verify `authHash`; return tokens + `wrapped_dek` + `wrapped_private_key` + `kdf_iterations` + `username` + `language`. An inactive account with **correct** credentials gets `403 "Not activated"` (leaks nothing — the caller already proved they hold the password); wrong credentials stay generic `401` | Implemented |
| `POST /auth/refresh` | Rotate refresh token, new access token | Implemented |
| `POST /auth/logout` | Delete refresh token, clear cookie | Implemented |
| `PUT /auth/password` | Change password: swap `authHash` + `wrapped_dek` + `wrapped_private_key`; revoke all refresh tokens | Implemented |
| `PUT /auth/language` | Change the caller's `language` preference (one of the 32 `ALLOWED_LANGUAGES` codes). Identified by the `__Secure-refresh_token` cookie, same as `/auth/refresh`/`/auth/logout` — no password reverification, since this isn't credential-sensitive | Implemented |
| `POST /auth/reset/request` | Email a reset token (proves mailbox ownership) | Implemented |
| `POST /auth/reset/confirm` | Two-step: `{token,email}` → `{recovery_mode[, recovery_key]}`; full body → store new `authHash` + re-wrapped envelope, revoke all sessions | Implemented |
| `DELETE /auth/account` | Delete user + tokens; fan out to `memoza-notes` to purge notes/grants/comments | Implemented |
| `GET /internal/auth/public-key?username=` | Internal-only: recipient lookup for sharing (by username), reached via the gateway after JWT verification. Returns `user_id` + canonical `username` + `public_key` for **active** users; `404` otherwise | Implemented |
| `GET /internal/auth/resolve-username?username=` | Internal-only: `username → user_id`, no auth check (the caller — the gateway's public-page route — is itself unauthenticated by design). Matches **active** users only; `404` otherwise | Implemented |

## Registration & activation (email-verified, enumeration-free)

Registration is a two-step flow; no account can log in, share, or be resolved
publicly until the emailed activation link is used:

1. `POST /auth/register` — the client sends `email, password = authHash,
   language, kdf_iterations` + the full key envelope (no username). The
   response is
   **always** a generic `202` "check your email":
   - **New email** → an inactive `users` row is created (envelope stored,
     `username = NULL`, `active = 0`), an `activation_token` is issued
     (hash-only, `ACTIVATION_TOKEN_TTL_MS`), and the activation link is
     mailed.
   - **Existing active email** → no row is touched; a "you already have an
     account — forgot your password?" mail is sent instead.
   - **Existing pending (inactive) email** → the row's envelope/credential is
     overwritten with the new submission and a fresh activation token is
     mailed (harmless: only the mailbox owner can ever activate, so whoever
     controls the mailbox wins).
   The client shows the recovery key immediately after this call regardless
   of outcome (it was generated client-side and this is the only moment it
   exists; for an already-registered email it's simply void).
2. **Activation** — the link opens the app's activation screen, which asks the
   user to pick their permanent `username` (live availability check via
   `GET /auth/username-available`, gated by the same activation token), then
   calls `POST /auth/activate {token, username}`. On success the account is
   active and the user logs in normally with their password. Clicking the
   link alone never grants a session — activation proves mailbox ownership,
   not password knowledge.

Unactivated rows older than `UNACTIVATED_RETENTION_MS` are lazily deleted
(during register), so an abandoned or squatted registration frees the email
again. Rate limiting for `/auth/*` is an edge concern — see
`CLOUDFLARE-HARDENING.txt`.

Gateway routing: `/notes/*` → `NOTES` service binding
(`/notes/internal/*` blocked, per security rules); `GET /users/public-key` →
verify JWT, then `AUTH` service binding → `/internal/auth/public-key`;
`GET /health` answered by the gateway itself; `GET /public/{username}/{page_no}`
answered **before** JWT verification (like `/health`) — the gateway calls
`AUTH` → `/internal/auth/resolve-username`, then, on a hit, `NOTES` →
`/notes/internal/public/{owner_id}/{page_no}`, and returns whichever 404s
first or the page content (see `docs/architecture/2-notes/README.md`).
Because this route composes internal URLs from anonymous, attacker-controlled
path parts, the gateway **must validate before composing**: `username` must
match the registration format and `page_no` must be digits only — anything
else is an immediate `404`, never forwarded (a raw `page_no` like
`1/../../purge-user` would otherwise normalize into a different internal
endpoint). The response to the public caller carries **only**
`{title, body, format}` — everything else on the internal row (`owner_id`,
`note_id`, `updated_at`) is stripped; nothing an anonymous reader doesn't
strictly need is ever returned.

## Internal-endpoint isolation (`/internal/auth/public-key`)

`memoza-auth` is unlike `memoza-notes`: it needs a public route
(`api.memoza.io/auth/*`) for register/login, so it can't rely on "no public
route" the way a pure internal service does. A naive `/auth/internal/*` path
would sit *inside* that public route pattern and become reachable directly
over the public internet, bypassing the gateway's JWT check — a Cloudflare
`routes` match and a service-binding call both invoke the same `fetch`
handler, so the worker can't tell which one delivered a given request.

Fix: the endpoint lives at `/internal/auth/public-key` — `internal` first,
outside the `/auth/*` prefix — so it falls structurally outside the public
route pattern. Cloudflare's edge only ever forwards `/auth/*` paths to this
worker; a public request to `/internal/auth/public-key` never reaches it at
all (Cloudflare has no other route pointing here, so it 404s at the gateway's
catch-all instead). The service binding is unaffected, since bindings invoke
the worker directly and never go through edge route matching. No runtime
check needed — see `NAMING-CONVENTIONS.md`'s "Internal-only" section for the
general pattern. `memoza-notes` doesn't need this at all because it has no
public `routes` for any path.

## Username (public handle, separate from login)

A permanent, unique, plaintext `username` on each user row — purely a public
handle for notebook page links (`memozasites.com/<username>/<page_no>`,
`memoza://username/pageno`, `.mmp` shortcut files) and, optionally, a nicer
share target than an email address. **It does not touch authentication.**

This was a real fork: the canonical crypto spec derives the KDF salt from
`SHA-256(lowercase email)`, so "log in with a username" would require either
(a) making username the salt too — workable, but it costs email login and
couples a public, permanent handle to key derivation — or (b) a random
per-account salt behind a pre-login lookup — workable, but it reopens the
user-enumeration surface the email-salt trick was specifically designed to
avoid. **Neither cost is necessary**, because nothing about public links
actually requires username to be the *login* identity:

- **Login stays email-only.** `salt = SHA-256(email)`, no pre-login endpoint,
  zero enumeration surface, no KDF change — the entire crypto flow in the
  canonical spec is untouched by this feature.
- **Username is picked at activation** (see "Registration & activation") — not
  at registration — and is **immutable** once set: a rename would silently
  break every public link, `.mmp` file, and `memoza://` shortcut ever issued,
  so there's no rename path (consistent with the "permanent numbering" promise
  the pages feature itself makes). Until activation the `users` row has
  `username = NULL` and is invisible to `resolve-username`.
- **Format rule (normative)**: 3–32 characters, `[a-z0-9-]` only, no leading/
  trailing hyphen. Stored and compared **lowercase** (`ada` and `Ada` are the
  same handle — the client lowercases before sending; the server normalizes
  and rejects anything outside the charset with `400`). This one rule closes
  three holes at once: no `@`/`.` means the availability endpoint can't be
  used to probe email addresses; no `/`/`%`/dots means a username can never
  break the gateway's URL composition or collide with static-asset paths on
  `app.memoza.io`; ASCII-only kills Unicode-homograph impersonation on public
  pages.
- **Never reused**: account deletion inserts the username into
  `retired_usernames` (see `table.md`) — otherwise a new user could register a
  deleted user's handle and every previously shared public link
  (`memozasites.com/<username>/<page_no>`, `.mmp` files, bookmarks) would
  silently resolve to the *new* person's pages: a content-takeover/phishing
  primitive. Register and the availability check both consult `users` **and**
  `retired_usernames`. The same table is pre-seeded with reserved
  system/product words (`admin`, `api`, `auth`, `public`, `assets`, `fonts`,
  `memoza`, … — full list in `table.md`) so they can never be claimed.
- **Resolution is one internal endpoint** (`/internal/auth/resolve-username`,
  above), unauthenticated by construction because its only caller is the
  gateway's already-unauthenticated public-page route. It never returns an
  email — only a `user_id` — so it adds no enumeration surface beyond "this
  username exists," which is inherent to any public link scheme.
- **Live availability check while typing**: `GET /auth/username-available`
  (above) is called (debounced, e.g. 300–500ms after the last keystroke) by
  the **activation screen** so the user sees "available" / "not available"
  before submitting. It requires the caller's **activation token** — the user
  has no JWT yet, but the token proves a pending registration, so this is not
  an open, anonymous enumeration/DoS endpoint, and every probe is tied to one
  pending account (loggable, countable, blockable). The response is **generic
  by design**: `available: false` never says whether the name is taken,
  reserved, or retired. `POST /auth/activate` still does the authoritative
  uniqueness check (generic `409` on conflict) — the availability endpoint is
  a UX nicety, not the source of truth, since a race between the check and
  the submit is possible.

## Password reset (recovery-key based)

The reset flow never lets the server see key material:

1. `POST /auth/reset/request {email}` — always 202 (no enumeration); if the
   user exists, email a single-use token (stored hash-only in `reset_token`).
2. Client collects the token + the user's **recovery key**, uses the recovery
   key to unwrap `dek` + `privateKey`, derives a new `authHash`/`wrapKey` from
   the new password, and re-wraps both secrets.
3. `POST /auth/reset/confirm {token, new_password, wrapped_dek,
   wrapped_private_key, wrapped_dek_recovery?, wrapped_private_key_recovery?}` —
   verify token, update credential + envelope, delete the token, revoke all
   refresh tokens.

## Account deletion

`DELETE /auth/account` (current credential re-verified) deletes the `users`
row (first inserting its `username` into `retired_usernames` — deleted handles
are never re-registrable), all `refresh_tokens`, and all `reset_token` rows,
then calls
`memoza-notes` over a service binding (`/notes/internal/purge-user`) to delete
that user's notes, grants, and comments. Notes the user **owned** are purged
(their share grants go with them); notes shared *to* the user lose only that
user's grant.

## Decisions

- **Key envelope lives in auth, not the notes service** — it changes only when
  credentials change, so keeping it next to `users` makes register / password
  change / reset one transaction in one service. Rejected: a separate keys
  service; storing envelopes in `memoza_notes` (password change would span two
  services).
- **Server re-hashes the client `authHash` with PBKDF2 (100k, free-tier cap)**
  — a leaked database exposes neither login credentials nor key material.
- **Public key stored in plaintext; lookup is authenticated** — needed so other
  users can wrap note keys to a recipient. Requiring a valid access token on the
  lookup limits the (inherent) membership-enumeration surface to logged-in
  users. Rejected: unauthenticated lookup (open enumeration).
- **Public-key lookup routed through the gateway, not exposed on `/auth/*`** —
  it needs JWT verification, which is the gateway's job; auth exposes it as an
  internal endpoint the gateway calls over a service binding, so auth keeps no
  JWT-verifying public route.
- **Reset depends on the user's `recovery_mode`** — in `private` mode email
  ownership alone cannot recover zero-knowledge data, so reset also needs the
  recovery key; in `convenient` mode the server decrypts the escrowed recovery
  key after the email token. Both flows re-wrap client-side. See the crypto
  spec's "Account recovery & password reset" for the escrow mechanism and its
  tradeoff.
- **Password change/reset revokes all refresh tokens** — other devices must log
  in again and need the new password to unwrap the envelope anyway.
- **Account deletion fans out via service binding** — auth cannot reach another
  service's D1 directly; the notes service owns its data and exposes an internal
  purge. Rejected: leaving notes orphaned (privacy + storage cost).
- **No roles / no RBAC** — every user has identical capability, and per-note
  authorization is carried entirely by `note_grant` rows in the notes service,
  not by anything on the identity. The original single-`Editor` role and the
  gateway RBAC hook were removed: a one-member role union made `checkRbac` a
  tautology and spread a meaningless value across the JWT, the `X-User-Role`
  header, and a DB column. Reintroduce a role only alongside a real second role
  and a real capability difference. The `users.role` column itself was dropped
  in migration `0002` once the `language` column gave the project a reason to
  touch the `users` table again (see Changes) — no benefit to a separate
  migration just for that one column.
- **Username is a separate public handle, not a login credential (Path 3 of
  three considered)** — login-by-username either costs email login (username
  becomes the KDF salt) or costs a new enumeration surface (random salt + a
  pre-login lookup). Keeping username purely for public links/sharing gets the
  same product outcome (stable public URLs, a shareable handle) for **zero**
  crypto risk: the existing email-salted login flow is untouched. Rejected:
  username-as-salt (loses email login); random per-user salt with a pre-login
  endpoint (reopens enumeration, and only *that* endpoint would need to be
  unauthenticated — not the whole login flow).
- **Username is immutable** — public links, `.mmp` files, and `memoza://`
  shortcuts embed it directly; a rename would break every one silently. No
  rename endpoint exists. Rejected: renameable-with-a-warning (adds a redirect/
  history table for a case the product doesn't need).
- **Registration is generic-202 + email activation; username moves to the
  activation step** — a distinguishable register response ("email exists") is
  an email-enumeration oracle, and a public pre-login username-availability
  endpoint is an anonymous enumeration/DoS surface on the login database.
  Activation closes both: register always answers the same thing, and the
  availability check is gated by the activation token (tied to one pending
  account). It also means every live account has a verified mailbox — a
  prerequisite the subscription feature needs anyway. Rejected: 409-on-existing
  register (enumeration); public username-available (open D1-read DoS surface);
  username at registration (forces the public availability endpoint to exist).
- **Activation never grants a session** — the link proves mailbox ownership
  only; login still requires the password-derived `authHash`. This makes the
  "attacker registers a victim's email first" case harmless: the victim's
  activation click doesn't hand the attacker a session, and the attacker can't
  log in without activating a mailbox they don't control. Stale inactive rows
  are lazily purged after `UNACTIVATED_RETENTION_MS` so the email frees again.

## JWT signing-key rotation

The gateway verifies access tokens against **`JWT_PUBLIC_KEY` and an optional
`JWT_PUBLIC_KEY_PREVIOUS`**, trying each (an expired-but-valid signature short-
circuits so `Token expired` is still reported). Rotation is therefore
zero-downtime: (1) generate a new key pair; (2) set the old public key as
`JWT_PUBLIC_KEY_PREVIOUS` on the gateway and the new key pair on auth
(`JWT_PRIVATE_KEY` = new private, `JWT_PUBLIC_KEY` = new public); (3) once all
tokens signed by the old key have expired (≤ 15 min), drop
`JWT_PUBLIC_KEY_PREVIOUS`. Access tokens are short-lived, so the overlap window
is minutes. `verifyToken` accepts an array of PEMs to make this a config change,
not a code change.

## Hardening (review findings)

- **Refresh-token rotation race → spurious logout.** *(fixed)* `refresh` no
  longer hard-deletes the rotated token; it shortens its expiry to a
  `REFRESH_GRACE_MS` window (10 s) so a concurrent/multi-tab refresh presenting
  the just-superseded token still succeeds instead of `401`ing the user out.
  Clients should still single-flight `/auth/refresh`.
- **`GET /health` unauthenticated.** *(fixed)* The gateway answers `/health`
  before JWT verification, so uptime/load-balancer probes need no token.
- **Strip `Authorization` before forwarding.** *(fixed)* The gateway now deletes
  `Authorization` (alongside the inbound identity headers) before forwarding to
  service workers, which never verify JWTs — least exposure.
- **`validatePassword` → minimal `authHash` guard.** *(pending — do with the
  E2EE register change, not before)* The current policy regex (upper/lower/digit)
  would *reject* a valid base64 `authHash`. It becomes a minimal guard only:
  non-empty string within a length cap — **no** character-class or strict-base64
  checks (the server can't judge password strength; the client enforces the sole
  rule, minimum 10 characters). Changing it in isolation breaks the present
  register flow, so it lands atomically when `register` accepts the E2EE fields.
- **Cap refresh tokens per user.** *(fixed)* `issueTokens` and `refresh` both
  call `enforceRefreshTokenCap`, which deletes the oldest-expiring rows for
  that user beyond `MAX_REFRESH_TOKENS_PER_USER` (var, 10) after every insert.
- **Escrow decryption is audited but not yet rate-limited.** *(partial —
  documented gap)* Every `convenient`-mode `reset/confirm` probe call that
  decrypts `escrowed_recovery` logs the user id (`console.log`, no secrets).
  True rate-limiting needs per-user counters with a TTL, which on the current
  free-tier stack (no KV/Durable Objects budgeted) would mean either a new D1
  table polled on every request or a paid binding — out of scope until traffic
  justifies it. In the meantime the blast radius is bounded by the reset
  token's own short TTL (`RESET_TOKEN_TTL_MS`) and single-use-per-request-cycle
  nature; an attacker still needs a live, unexpired token, which requires
  either mailbox access or a leaked link.

## Changes

- 2026-07-23 — Access token now also carries a `username` claim; the gateway
  forwards it as `X-Username` (stripping any client copy) so downstream services
  get a trusted username with no lookup. The public-key lookup for sharing is now
  keyed by **username** (not email) and echoes the canonical username. Enables
  username-based sharing and username-labelled comments/recipient lists in notes.
- 2026-07-07 — Module copied from a sibling project and adapted to Memoza;
  design doc created; E2EE key-envelope extension planned.
- 2026-07-08 — Added user keypair (for note sharing), password-reset flow,
  account deletion, and authenticated public-key lookup to the design.
- 2026-07-09 (review) — Recorded per-user `recovery_mode` (escrow for
  `convenient`); documented hardening items; fixed the `password_hash` format in
  `table.md` to match the code.
- 2026-07-09 (implemented) — Gateway: fixed the leftover `MEDIA`→`NOTES` binding
  (config pointed at the wrong service too), unauth `/health`, strip
  `Authorization` downstream, and JWT key rotation (`verifyToken` accepts
  current + previous public key). Auth: refresh-rotation grace window
  (`REFRESH_GRACE_MS`). `validatePassword`/register E2EE change still pending
  (atomic with the E2EE build).
- 2026-07-10 (implemented) — Finished the E2EE delta: `register`/`login` accept
  and return the full key envelope; `validatePassword` replaced with a minimal
  `authHash` guard (`validateAuthHash`); added `PUT /auth/password`,
  `POST /auth/reset/request` + `/reset/confirm` (two-step, escrow-aware),
  `DELETE /auth/account` (fans out to `memoza-notes`), and the
  `/auth/internal/public-key` lookup. Added the `X-Internal-Secret` gate for
  `/auth/internal/*` (see the new section above — a gap in the original plan,
  since `/auth/*` is also publicly routed). Added `MAX_REFRESH_TOKENS_PER_USER`
  cap. Gateway: added the `AUTH` binding and `/users/public-key` forwarding;
  dropped the `/folders/*` route (folders were dropped from the notes design
  on 2026-07-09, but the gateway hadn't been updated). Plan deleted.
- 2026-07-10 (simplification) — Replaced the `X-Internal-Secret` header check
  on the internal public-key lookup with a structural fix: moved the endpoint
  from `/auth/internal/public-key` to `/internal/auth/public-key`, which falls
  outside the `/auth/*` public route pattern entirely, so it's unreachable from
  the public internet with no runtime check needed. Simpler and stronger than
  a secret (nothing to provision or leak). `INTERNAL_SHARED_SECRET` removed
  from both workers. See `NAMING-CONVENTIONS.md` for the general pattern.
- 2026-07-10 (simplification) — `memoza-auth` and `memoza-gateway` had
  near-identical CORS helper functions; moved them into `@memoza/shared`
  (`shared/src/cors.ts`, already an existing package for cross-worker code) so
  there's one implementation instead of two. Caught and fixed a real bug in
  the process: auth's preflight only ever allowed `POST, OPTIONS`, which meant
  `PUT /auth/password` and `DELETE /auth/account` (added in this same build)
  would have failed CORS preflight from the browser.
- 2026-07-10 (frontend integration fix) — The `reset/confirm` probe response
  was missing `wrapped_dek_recovery` / `wrapped_private_key_recovery`: the
  client has no other way to fetch the account's existing recovery-wrapped
  envelope before it's authenticated, and without it there's nothing to unwrap
  with the recovery key. Added both fields to the probe response (both modes).
  `api-auth-usage.md` updated to match.
- 2026-07-15 (design) — Added a permanent, unique `username` public handle
  (registration field, immutable, separate from login) to support the notes
  service's page-publishing feature. Considered making username the login
  identity/KDF salt (costs email login) and a random-salt pre-login lookup
  (reopens enumeration) before settling on "username never touches auth" —
  see "Username (public handle, separate from login)" above. Added the
  internal `resolve-username` endpoint and the gateway's unauthenticated
  `GET /public/{username}/{page_no}` composition, plus a public
  `GET /auth/username-available` endpoint for a live availability check in the
  registration form. Design only; not yet implemented.
- 2026-07-15 (security review) — Hardened the username design: normative
  format rule (3–32, `[a-z0-9-]`, lowercase-normalized, case-insensitive
  uniqueness); new `retired_usernames` table (deleted handles never
  re-registrable — prevents public-link takeover — plus a seeded reserved-word
  list); the gateway must validate `username`/`page_no` before composing
  internal URLs and must whitelist the public-page response fields. Suggested
  edge-level hardening (rate limiting, `/public/*` caching, response headers)
  recorded in `CLOUDFLARE-HARDENING.txt` at the repo root. Still design only.
- 2026-07-16 (design) — Registration redesigned to generic-202 + email
  activation: register no longer collects a username or returns tokens; the
  account stays inactive until `POST /auth/activate {token, username}` — the
  activation step is where the username is picked, and
  `GET /auth/username-available` is now gated by the activation token instead
  of being public (availability answers are generic — never taken vs
  reserved). Login returns `403 "Not activated"` on correct credentials for an
  inactive account. New `activation_token` table +
  `ACTIVATION_TOKEN_TTL_MS`/`UNACTIVATED_RETENTION_MS` vars. Public-page
  response trimmed to `{title, body, format}` (dropped `updated_at`). Old
  pre-prod rows don't matter — the DB will be recreated. Design only; build
  plan in `backend-services/1-user-access-management/IMPLEMENTATION-PLAN.md`.
- 2026-07-16 (implemented) — Built the whole delta above: `users` gained
  `username` (nullable, unique) and `active` now defaults to `0`; added
  `activation_token` and `retired_usernames` (seeded with the reserved-word
  list). `register` is now a single `INSERT … ON CONFLICT(email) DO UPDATE …
  WHERE users.active = 0 RETURNING id` — atomic instead of read-then-write, so
  a concurrent duplicate registration can't race the generic-202 branch;
  `RETURNING` absent means an active row already owns the email, so a
  "you already have an account" mail goes out instead of an activation link.
  Added `activate` (single `UPDATE … WHERE username IS NULL AND NOT EXISTS
  (retired check) …`, `UNIQUE` violation on `username` caught for the
  taken-by-another-concurrent-activation case — both collapse to the same
  generic `409`) and `username-available`. `login` returns `403 "Not
  activated"` for `active=0`. Added `GET /internal/auth/resolve-username` and
  the gateway's unauthenticated `GET /public/{username}/{page_no}` compose
  (validates `username`/`page_no` before building any internal URL; returns
  only `{title, body, format}`). Added `X-Content-Type-Options: nosniff`
  (shared `withSecurityHeaders`, also folded into `handlePreflight`) and
  `Cache-Control` (`no-store` everywhere on both workers except `public,
  max-age=60` on `/public/*`). `isValidUsernameFormat`/`normalizeUsername`
  moved to `@memoza/shared` since both auth (activate/username-available) and
  the gateway (public-page validation) must apply the identical format check.
  Account deletion now retires the username (`reason='deleted'`) before
  deleting the row, skipped when still `NULL`. Plan deleted.
- 2026-07-18 (implemented) — Converted `auth-worker` from a hand-run
  `schema.sql` to tracked migrations, matching `memoza-notes`: the full
  5-table schema (incl. the `retired_usernames` seed data) became
  `migrations/0001_init.sql`, `schema.sql` deleted. The pre-existing remote
  `memoza_auth` DB predated the current schema (old 3-table shape, one stale
  test row missing `username`/`activation_token`/`retired_usernames`
  entirely) so it was wiped and rebaselined from `0001_init.sql` rather than
  migrated in place.
- 2026-07-18 (implemented) — `POST /auth/login` now also returns `username`.
  Building a published page's shareable link (`app.memoza.io/<username>/
  <page_no>`, `frontend-core`'s notebook UI) needs the caller's own username,
  and no endpoint previously returned it to its owner — login was the natural
  place since it already returns the rest of the per-user envelope. See
  `docs/api/api-auth-usage.md`.
- 2026-07-19 (implemented) — CORS now supports an allowlist instead of a
  single origin: `shared/src/cors.ts` reads a comma-separated var and checks
  membership (still exact-match, still reflects only the matched origin, never
  a wildcard). New `CORS_ALLOWED_ORIGINS` var on both workers, set to
  `https://app.memoza.io,tauri://localhost,http://tauri.localhost` so the
  Tauri desktop shell (`frontend/desktop`) can call the API — Tauri's webview
  sends `Origin: tauri://localhost` on macOS/Linux and `http://tauri.localhost`
  on Windows, neither of which is the web app's origin. `FRONTEND_ORIGIN`
  stays on `memoza-auth` only, now scoped to its original other job of
  building activation/reset-link email URLs; dropped entirely from
  `memoza-gateway`, which had no other use for it.
- 2026-07-20 (RBAC removal + auth hygiene) — Removed roles entirely: the
  `Role` type, the `role` JWT claim, the gateway's `checkRbac` hook, and the
  gateway-set `X-User-Role` header are all gone (see the "No roles / no RBAC"
  decision above). The gateway still *strips* an inbound `X-User-Role` — a
  client-controlled identity header should never survive the trust boundary
  even when nothing downstream reads it. `handleRefresh`'s `SELECT role` became
  `SELECT id`: the query was doing double duty as a user-existence check, so it
  was kept rather than dropped (removing it would have let a refresh token for
  a deleted user still mint access tokens). Also: the activation email now
  HTML-escapes the user-supplied `name`, and a stray `console.log` of the
  user id on the escrow-decrypt path was removed.
- 2026-07-20 (`role`/`name` dropped, `language` added) — Migration
  `0002_language_and_cleanup.sql`: dropped `users.role` (the vestigial
  single-`Editor` column noted below, finally migrated away for no remaining
  benefit) and `users.name` (collected at registration but the only thing that
  ever read it was the activation email's "Hi {name}" greeting — not shown
  anywhere in the app UI; dropped rather than kept as unused surface area, per
  `CODING-RULES.md`'s minimalism). Added `users.language` (`NOT NULL DEFAULT
  'en'`, one of 32 codes in `@memoza/shared`'s new `ALLOWED_LANGUAGES`) for the
  frontend's new i18n system (`docs/architecture/frontend-core/README.md`).
  `POST /auth/register` now takes `language` instead of `name`; `POST
  /auth/login` returns it so other devices/sessions converge on the same
  preference; new `PUT /auth/language` lets a signed-in user change it later
  (Settings). The new endpoint identifies the caller via the
  `__Secure-refresh_token` cookie, matching `/auth/refresh`/`/auth/logout`'s
  existing pattern, rather than the password-reverification pattern used by
  `/auth/password`/`/auth/account` — changing a display preference isn't
  credential-sensitive, so it doesn't need the stronger check those endpoints
  use.
