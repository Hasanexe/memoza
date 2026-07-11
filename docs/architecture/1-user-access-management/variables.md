# Variables & Secrets — `memoza-auth` + `memoza-gateway`

Quick reference only. Design rationale: `README.md`.

## `memoza-auth` vars (`auth-worker/wrangler.jsonc`)

| Var | Purpose |
|---|---|
| `FRONTEND_ORIGIN` | Allowed CORS origin (also used to build the reset-link URL) |
| `RESEND_FROM` | From-address for outbound email |
| `PBKDF2_ITERATIONS` | Server-side rehash iteration count for the client `authHash` (free-tier capped at 100,000) |
| `REFRESH_TOKEN_TTL_MS` | Refresh token lifetime |
| `REFRESH_TOKEN_MAX_AGE_S` | Refresh cookie `Max-Age` |
| `REFRESH_GRACE_MS` | Grace window a just-rotated refresh token stays valid (multi-tab safety) |
| `RESET_TOKEN_TTL_MS` | Password-reset token lifetime |
| `MAX_REFRESH_TOKENS_PER_USER` | Cap on live refresh tokens per user; oldest evicted beyond this |

## `memoza-auth` secrets

| Secret | Purpose |
|---|---|
| `JWT_PRIVATE_KEY` | Signs access tokens (EdDSA) |
| `JWT_PUBLIC_KEY` | Paired public key (published to the gateway's config) |
| `RESEND_API_KEY` | Outbound email provider |
| `ESCROW_PRIVATE_KEY` | Decrypts `escrowed_recovery` in `convenient`-mode password resets |

## `memoza-gateway` vars (`gateway-worker/wrangler.jsonc`)

| Var | Purpose |
|---|---|
| `FRONTEND_ORIGIN` | Allowed CORS origin |

## `memoza-gateway` secrets

| Secret | Purpose |
|---|---|
| `JWT_PUBLIC_KEY` | Verifies access tokens (current signing key) |
| `JWT_PUBLIC_KEY_PREVIOUS` | Verifies tokens signed by the previous key during rotation (optional) |
