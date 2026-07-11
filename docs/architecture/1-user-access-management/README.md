# User Access Management — `memoza-auth` + `memoza-gateway`

Authentication, key-envelope storage, and routing layer for Memoza. Two
Cloudflare Workers sharing the `api.memoza.io` host by path. Data model:
`table.md`. Crypto spec (keys, KDF, envelope formats, grants): the canonical
spec in `docs/architecture/README.md` — not restated here.

## Components

| Worker | Route | Role |
|---|---|---|
| `memoza-auth` | `api.memoza.io/auth/*` | Registration, login, refresh, logout, password change, password reset, account deletion; owns D1 `memoza_auth`, the JWT **private** key, and every user's key envelope + public key |
| `memoza-gateway` | `api.memoza.io/*` (everything else) | Verifies EdDSA access JWTs (against the current + optional previous **public** key, for zero-downtime rotation), answers `/health` unauthenticated, strips inbound `Authorization`/`X-User-Id`/`X-User-Role`, attaches trusted values, forwards `/notes/*` to `memoza-notes` over a service binding; will also serve the authenticated public-key lookup |

Access tokens: EdDSA JWTs, 15 min, claims `user_id` + `role` (single role
`Editor` for now). Refresh tokens: 32 random bytes, rotated on every refresh,
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
| `POST /auth/register` | Create account; store key envelope + public key; return access token + refresh cookie; send welcome email | Implemented |
| `POST /auth/login` | Verify `authHash`; return tokens + `wrapped_dek` + `wrapped_private_key` + `kdf_iterations` | Implemented |
| `POST /auth/refresh` | Rotate refresh token, new access token | Implemented |
| `POST /auth/logout` | Delete refresh token, clear cookie | Implemented |
| `PUT /auth/password` | Change password: swap `authHash` + `wrapped_dek` + `wrapped_private_key`; revoke all refresh tokens | Implemented |
| `POST /auth/reset/request` | Email a reset token (proves mailbox ownership) | Implemented |
| `POST /auth/reset/confirm` | Two-step: `{token,email}` → `{recovery_mode[, recovery_key]}`; full body → store new `authHash` + re-wrapped envelope, revoke all sessions | Implemented |
| `DELETE /auth/account` | Delete user + tokens; fan out to `memoza-notes` to purge notes/grants/comments | Implemented |
| `GET /internal/auth/public-key?email=` | Internal-only: recipient public-key lookup for sharing; reached via the gateway after JWT verification | Implemented |

Gateway routing: `/notes/*` → `NOTES` service binding
(`/notes/internal/*` blocked, per security rules); `GET /users/public-key` →
verify JWT, then `AUTH` service binding → `/internal/auth/public-key`;
`GET /health` answered by the gateway itself.

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
row, all `refresh_tokens`, and all `reset_token` rows, then calls
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
- **Single role `Editor`** — no admin UI; the gateway RBAC hook stays trivial
  until a real second role exists.

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
