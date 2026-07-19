# Variables — `app.memoza.io` (web)

Build-time only (Vite `.env`, see `frontend/web/.env.example`). No secrets —
this is a public static bundle; the zero-knowledge design keeps every real
secret (passwords, keys) off the client build entirely.

| Var | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Base URL the API clients call; defaults to `https://api.memoza.io` if unset (useful for pointing a local build at a dev API) |
| `VITE_ESCROW_PUBLIC_KEY` | The published escrow RSA-OAEP-3072 public key (PEM), used only if a user opts into `convenient` recovery mode at registration. If unset, the `convenient` option is hidden and only `private` mode is offered |
| `VITE_PUBLIC_APP_ORIGIN` | Origin used to build a published page's shareable link (`<origin>/<username>/<page_no>`); defaults to `https://app.memoza.io` if unset |

CSP is delivered via `frontend/web/public/_headers` (Cloudflare Workers static
assets), not an env var — edit that file directly to change it.
