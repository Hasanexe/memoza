# Auth API — Frontend Integration Guide

Base URL: `https://api.memoza.io`. All bodies are JSON; all errors are
`{ "error": "message" }`. Access tokens are Bearer JWTs (~15 min); the refresh
token is an `HttpOnly` cookie — send `credentials: 'include'` on `/auth/*`
calls so it flows automatically. Note endpoints are in `api-notes-usage.md`.

**All cryptography happens on the client.** The server never receives your
password or any usable key. This guide states what to send; the exact
algorithms (PBKDF2 params, HKDF info strings, envelope byte layout) are the
canonical crypto spec in the architecture docs — implement against that, this
guide names the fields.

## Derivations you compute before calling

Given `email` (lowercased) and `password`:

1. `masterKey` ← PBKDF2(password, salt = SHA-256(email), 600000).
2. `authHash` ← PBKDF2(masterKey, salt = password, 1) → base64. **This is the
   `password` field you send** — the raw password never leaves the device.
3. `wrapKey` ← HKDF(masterKey, "memoza-wrap").

At registration you additionally generate: a random `dek`, an RSA-OAEP-3072
`keypair`, and a 128-bit `recoveryKey`; then produce `wrapped_dek`,
`wrapped_private_key`, `public_key` (plaintext SPKI), and the two recovery
blobs.

**Password rule (client-enforced): minimum 10 characters, nothing else.** The
server can't check password strength (it only sees `authHash`); it just rejects
an empty or over-long `password` field.

## `POST /auth/register`

Request:

```json
{
  "email": "user@example.com",
  "name": "Ada",
  "password": "<authHash>",
  "kdf_iterations": 600000,
  "public_key": "<base64 SPKI>",
  "wrapped_dek": "<base64>",
  "wrapped_private_key": "<base64>",
  "wrapped_dek_recovery": "<base64>",
  "wrapped_private_key_recovery": "<base64>",
  "recovery_mode": "private",
  "escrowed_recovery": "<base64, only if recovery_mode = convenient>"
}
```

`recovery_mode` is `"private"` (default, true zero-knowledge — reset needs the
recovery key) or `"convenient"` (email-only reset, weaker — see below). In
`convenient` mode also send `escrowed_recovery`: the recovery key encrypted to
the published `ESCROW_PUBLIC_KEY` (RSA-OAEP). In `private` mode omit it.

**The response is always `202`** with a generic "check your email" message —
whether or not the email already has an account (no enumeration). No tokens
are returned; the account can't log in until it's activated via the emailed
link. Show the recovery key once right after this call — it was generated
client-side and this is the only moment it exists. Then show a "check your
email to activate" screen. `400` only for validation errors.

There is **no username field** — the username is picked at activation (below).

## `GET /auth/username-available?username=<username>&token=<activation token>`

Called from the **activation screen** (debounced ~300–500ms after the user
stops typing) while they're picking their username. Requires the activation
token from the emailed link — there's no JWT yet, and the token is what makes
this endpoint non-public.

`200` → `{ "available": true }` or `{ "available": false }`. The answer is
deliberately generic: `false` never says whether the name is taken, reserved,
or retired. `400`/`401` for a missing/invalid/expired token. This is a UX
convenience, not the authoritative check — `POST /auth/activate` can still
`409` after this said `true` (someone grabbed it in between).

## `POST /auth/activate`

Request: `{ "token": "<from the email link>", "username": "ada" }`.

**`username` is permanent — there is no rename endpoint.** Format: 3–32
characters, lowercase `a-z`, `0-9`, and `-` (no leading/trailing hyphen);
lowercase it client-side before sending — comparisons are case-insensitive
(`Ada` = `ada`). It's your public handle for page links
(`app.memoza.io/<username>/<page_no>`) and shortcuts; it plays no role in
login or key derivation (that's still email — see
`docs/architecture/1-user-access-management/README.md`'s "Username" section).

`200` → account activated; send the user to the login screen (activation
never grants a session — logging in still needs the password). `409` →
username not available, pick another (the token stays valid). `400` →
invalid/expired token (re-register to get a fresh link).

## `POST /auth/login`

Request: `{ "email": "…", "password": "<authHash>" }`.

`200` →

```json
{
  "access_token": "…",
  "token_type": "Bearer",
  "kdf_iterations": 600000,
  "wrapped_dek": "<base64>",
  "wrapped_private_key": "<base64>",
  "username": "ada"
}
```

`username` is the account's permanent public handle (set at activation); cache it in
the client session alongside `email` — it's what builds a published page's
shareable link (`app.memoza.io/<username>/<page_no>`, see `api-notes-usage.md`'s
"Pages & public sharing").

Unwrap `dek` and `privateKey` with `wrapKey` and hold them only in an in-memory
session module (never `localStorage`/`sessionStorage`/IndexedDB — see
`SECURITY-RULES.md`'s ban on raw key bytes in web storage). They live only for
the tab's lifetime.
`401` → `{ "error": "Invalid credentials" }` (generic — no enumeration).
`403` → `{ "error": "Not activated" }` — correct credentials on an account
that hasn't used its activation link yet; show a "check your email to
activate" message (this leaks nothing: the caller already proved they hold
the password).

## `POST /auth/refresh`

No body; relies on the refresh cookie. `200` → new `access_token` + rotated
cookie. `401` if missing/expired/invalid. Call this transparently once on any
`401` from a protected endpoint, then retry the original request.

## `POST /auth/logout`

No body; relies on the refresh cookie. `200`, clears the cookie. Also clear
the in-memory session locally — there is nothing in web storage to remove.

## `PUT /auth/password`

Re-derive everything under the new password client-side (unwrap `dek` +
`privateKey` with the old `wrapKey`, re-wrap with the new one).

Request:

```json
{
  "email": "…",
  "old_password": "<old authHash>",
  "new_password": "<new authHash>",
  "wrapped_dek": "<new base64>",
  "wrapped_private_key": "<new base64>",
  "wrapped_dek_recovery": "<new base64, optional>",
  "wrapped_private_key_recovery": "<new base64, optional>"
}
```

`200` → fresh `access_token` + new refresh cookie (current device stays in);
all other sessions are revoked. `401` if `old_password` is wrong.

## `POST /auth/reset/request`

Request: `{ "email": "…" }`. Always `202` (no enumeration). If the account
exists, an email with a single-use token link is sent.

`200` body carries the account's `recovery_mode` **only after** the token is
presented (see confirm) — never in the `request` response, to avoid leaking it.

## `POST /auth/reset/confirm`

Two flows depending on the account's `recovery_mode`. Both start with a probe
call carrying only `{ "token": "…", "email": "…" }` (no `new_password`):

`200` →

```json
{ "recovery_mode": "private", "wrapped_dek_recovery": "<base64>", "wrapped_private_key_recovery": "<base64>" }
```

or, in `convenient` mode:

```json
{
  "recovery_mode": "convenient",
  "recovery_key": "<base64>",
  "wrapped_dek_recovery": "<base64>",
  "wrapped_private_key_recovery": "<base64>"
}
```

`wrapped_dek_recovery` / `wrapped_private_key_recovery` are the account's **existing** recovery-wrapped blobs (from registration) — the probe returns them because the client has no other way to fetch them before it's authenticated. Unwrap both with the recovery key (pasted, or returned above in `convenient` mode) to get `dek` + `privateKey`, then re-wrap under the new password. `400` → `{ "error": "Invalid or expired token" }`.

- **`private`** — the probe just confirms the token and mode; the user pastes
  their **own** recovery key (never sent to the server), the client uses it to
  unwrap `dek` + `privateKey`, then re-wraps both under the new password.
- **`convenient`** — the probe response already carries the decrypted
  `recovery_key` (the server decrypted `escrowed_recovery` with its
  `ESCROW_PRIVATE_KEY` secret). The client then proceeds exactly as `private`
  (unwrap, re-wrap) using that key.

Either way, submit the full body next (same `token` — it's still valid and
single-use until this call consumes it):

```json
{
  "token": "<from email link>",
  "email": "…",
  "new_password": "<new authHash>",
  "wrapped_dek": "<new base64>",
  "wrapped_private_key": "<new base64>",
  "wrapped_dek_recovery": "<new base64>",
  "wrapped_private_key_recovery": "<new base64>",
  "escrowed_recovery": "<new base64, convenient mode only>"
}
```

`200` on success (all sessions revoked; user logs in fresh). `400`/`401` for an
invalid or expired token. In `convenient` mode the server rate-limits and audits
(id only) escrow decryptions.

## `DELETE /auth/account`

Request: `{ "email": "…", "password": "<authHash>" }` (re-verify current
credential). `200` deletes the account and purges all the user's notes,
grants, and comments. Clear the in-memory session afterward (and, on the
desktop shell, wipe the local SQLite cache and OS-keystore entry).

## `GET /users/public-key?email=<email>`

Authenticated (Bearer token, via the gateway). Used before sharing a note.
`200` → `{ "user_id": "…", "public_key": "<base64 SPKI>" }`. `404` if no such
Memoza user (this is the accepted membership-enumeration surface). Wrap the
note's CEK to `public_key`, then call `POST /notes/{id}/share` (see
`api-notes-usage.md`).
