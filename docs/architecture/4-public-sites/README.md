# Public Sites — `memoza-sites` on `memozasites.com`

One thin Cloudflare Worker that gives Memoza's `format:html` notes a place to
**run** — full interactivity (the note's own scripts, styles, forms) — without
ever weakening the app's strict CSP or exposing the app origin's keys and
session to user-authored content. It also serves every **published page** as a
standalone public website.

`memozasites.com` is a deliberately **neutral, separate brand/origin**:

- **Origin isolation** — user HTML runs on a different origin than
  `app.memoza.io`, so its scripts can never touch the app's DOM, IndexedDB
  (keys), or session state.
- **No credentials to steal** — the worker sets no cookies, requires no auth,
  and holds no secrets. There is nothing on this origin worth phishing.
- **Brand separation** — a malicious published page lives on a neutral domain,
  not on `*.memoza.io`, so it cannot borrow Memoza's trust.

## Component view

```
memozasites.com  (worker: memoza-sites — no DB, no auth, no cookies)
├─ GET /_runner              trusted sandbox runner (static HTML, used by the web app)
├─ GET /{username}/{pageNo}  standalone public site for a published page
├─ GET /reader.js|.css|...   static assets: the Markdown reader bundle (built
│                            from frontend/public-reader, reuses the core renderer)
└─ (service binding GATEWAY → memoza-gateway, /public/{username}/{pageNo} composition)
```

There is **no database**. The published plaintext lives in `memoza-notes`'
`public_page` mirror; this worker only fetches it through the gateway's
existing unauthenticated composition and wraps it in a document.

## How HTML notes render (all platforms)

In-app rendering has **one feed path**: the client always holds the plaintext
of any note it can display (owner or grantee), so `format:html` is always
rendered by pointing a sandboxed iframe at a **runner** page and
`postMessage`-ing the HTML into it. The runner nests the content in a `srcdoc`
frame so inline scripts execute under the runner's permissive CSP.

| Context | Runner origin | Why |
|---|---|---|
| Web (`app.memoza.io`) | `https://memozasites.com/_runner` | A real second origin is required: `srcdoc`/`blob:` iframes inherit the parent's strict CSP, which blocks the note's scripts |
| Desktop/mobile (Tauri) | local custom scheme (`sandbox://localhost` / `http://sandbox.localhost` on Windows) serving the **same runner HTML** | Same isolation, zero network dependency — HTML notes are fully interactive **offline** |

Iframe sandbox tokens everywhere: `allow-scripts allow-forms allow-modals` —
never `allow-same-origin`, `allow-top-navigation`, or `allow-popups`.
Consequence (accepted): `window.open`/`target=_blank` inside a note does
nothing; regular links navigate within the frame.

The runner:

1. Posts `{type:"memoza-runner-ready"}` to its parent.
2. Accepts `{type:"memoza-html", html}` **only** from an allow-listed parent
   origin (`PARENT_ALLOWED_ORIGINS` var on the worker; compiled-in Tauri
   origins on desktop) and renders it into the nested `srcdoc` frame.
3. Reports the content height back (`{type:"memoza-height", value}`) so the
   embedding note view can auto-size. The parent validates `event.source`
   against the iframe's `contentWindow` before trusting any message.

`format:md` notes are untouched: they keep the existing in-app sanitized
render (`frontend/core/src/views/markdown.ts`, DOMPurify + client-side
Mermaid) — sanitized Markdown has no script execution and no style-bleed
problem, so it needs no iframe.

## Public sites — `GET /{username}/{pageNo}`

The worker calls the gateway's existing `/public/{username}/{pageNo}`
composition over a service binding (username → user id in `memoza-auth`,
plaintext page in `memoza-notes`), then:

- **`format:html`** — returns the stored body **as the whole document**
  (`text/html`) with `Content-Security-Policy: sandbox allow-scripts
  allow-forms allow-modals`. The `sandbox` directive gives every published
  HTML page an opaque origin, so one user's page can never read
  `localStorage`/state another user's page left in a visitor's browser (all
  pages share the `memozasites.com` origin otherwise).
- **`format:md`** — returns a small shell document with the plaintext
  **embedded as JSON** plus `/reader.js` + `/reader.css`, a bundle built from
  `frontend/public-reader` that reuses the exact core render pipeline (marked
  + DOMPurify + Mermaid, `@memoza/core/views/markdown`). No server-side
  Markdown rendering: a second pipeline would drift from the client one and
  could never run Mermaid. Embedding the JSON costs nothing (the worker
  already composed the plaintext) and avoids a second fetch/CORS.
- Both carry `Cache-Control: public, max-age=<PUBLIC_CACHE_MAX_AGE_S>` (60 s,
  matching the existing `/public/*` quota-protection cache — see
  `CLOUDFLARE-HARDENING.txt`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and `frame-ancestors 'none'` via CSP
  (nothing ever frames the standalone site — in-app viewing uses the runner
  path instead).

The canonical shareable URL is
**`https://memozasites.com/{username}/{pageNo}`** (the copy-link/publish UI
builds it via `VITE_PUBLIC_SITE_ORIGIN`). The old in-app reader at
`app.memoza.io/{username}/{pageNo}` is **removed** (pre-production, no links
to preserve — no redirect).

## Endpoint map

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /_runner` | none | Sandbox runner page (permissive CSP, `frame-ancestors` = app origins) |
| `GET /{username}/{pageNo}` | none | Standalone public site (html: body as document; md: shell + reader bundle) |
| `GET /<asset>` | none | Reader bundle static assets (served by Workers assets before the worker runs) |

Anything else: minimal HTML 404.

## Decisions

- **One in-app feed path (postMessage), server-rendered only for the
  standalone site.** An earlier draft iframed the public route for in-app
  viewing of public notes; dropped — the client always has the plaintext
  already, postMessage is never stale (the public route is up to 60 s edge
  cached), and it lets the public route set `frame-ancestors 'none'`.
- **Desktop uses a local runner, not the remote one.** `srcdoc`/`blob:`
  documents inherit the embedding page's CSP, so a genuinely different origin
  is required for the note's scripts to run; Tauri's
  `register_uri_scheme_protocol` provides one locally (`sandbox://`). This
  removed the planned "static styled fallback when offline" degrade path
  entirely — offline HTML notes are fully interactive. The runner HTML is a
  single file (`sites-worker/src/runner.html`) compiled into the desktop
  binary via `include_str!` — one source, two servers.
- **Markdown public pages moved here too** (one URL scheme), but rendered
  client-side by the bundled core renderer, not server-side (rejected: `marked`
  in the worker — pipeline drift, no Mermaid, extra CPU per request).
- **`CSP: sandbox` on published HTML pages** — trades user pages' ability to
  use `localStorage`/cookies for cross-page storage isolation on the shared
  origin. Revisit only with per-user subdomains (rejected for now: Universal
  SSL covers only single-level subdomains, and wildcard user subdomains are a
  paid feature).
- **No `allow-popups` / `allow-downloads`** sandbox tokens (owner decision,
  2026-07-22) — tight default; add later if real pages need them.
- **No redirect from `app.memoza.io/{username}/{pageNo}`** — pre-production,
  no existing links to preserve; the SPA reader route and view were deleted.
- **No R2 / no new storage** — the `public_page` mirror plus the 60 s edge
  cache is the serving story until traffic proves otherwise; R2 would be a
  drop-in later without architecture change.
- **Abuse/takedown**: publishing is a static-hosting surface. The mechanism
  already exists (deleting/trashing the note stops serving within the cache
  TTL); a ToS line and a reporting path are product work, tracked as pending
  hardening, not code here.

## Changes

- 2026-07-22 — Service created: `/_runner` + `/{username}/{pageNo}` +
  reader-bundle assets; canonical public URL moved from
  `app.memoza.io/{username}/{pageNo}` to `memozasites.com/{username}/{pageNo}`;
  in-app SPA public reader removed; `format:html` in-app rendering moved from
  sanitized-inline to the sandboxed runner iframe on all platforms.
