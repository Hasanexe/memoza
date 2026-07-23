# `memoza-sites` — config vars

Names and purpose only — never values. No secrets: this worker holds none by
design (see the service `CLAUDE.md` guardrail).

| Var (`wrangler.jsonc` `vars`) | Purpose |
|---|---|
| `PARENT_ALLOWED_ORIGINS` | Comma-separated app origins allowed to feed HTML into `/_runner` via postMessage, and the runner's CSP `frame-ancestors` list |
| `PUBLIC_CACHE_MAX_AGE_S` | `Cache-Control: public, max-age` seconds on `/{username}/{pageNo}` responses (keep in agreement with the edge cache rule in `CLOUDFLARE-HARDENING.txt`) |

Bindings:

| Binding | Purpose |
|---|---|
| `GATEWAY` | Service binding to `memoza-gateway` — reuses its unauthenticated `/public/{username}/{pageNo}` composition |
