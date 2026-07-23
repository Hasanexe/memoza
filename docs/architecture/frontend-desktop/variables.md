# Variables — desktop shell

## Build-time (Vite `.env`, see `frontend/desktop/.env.example`)

| Var | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Base URL the API clients call; defaults to `https://api.memoza.io` if unset |
| `VITE_ESCROW_PUBLIC_KEY` | Published escrow public key (PEM); if unset, `convenient` recovery mode is hidden |
| `VITE_PUBLIC_SITE_ORIGIN` | Origin of the `memoza-sites` public-page host, used to build a published page's shareable link; defaults to `https://memozasites.com` if unset (the `format:html` runner is local — see below — so this var never affects rendering) |

## Native config (`frontend/desktop/src-tauri/tauri.conf.json`)

| Key | Purpose |
|---|---|
| `identifier` | `io.memoza.desktop` — app bundle id, also the OS-keystore service scope prefix |
| `plugins.deep-link.desktop.schemes` | `memoza` — the custom URL scheme used for password-reset links and the notebook-shortcut deep links (`memoza://page/<N>`, `memoza://note/<uuid>`) |
| `bundle.fileAssociations` | Registers the `.mmp` (Memoza Page) extension at install time so double-clicking one launches/focuses the app; the launch-arg path is read once at startup (`take_pending_mmp_url`) and routed through the same deep-link handler |
| `plugins.updater` | Disabled (`active: false`) until a real update endpoint + signing key exist |
| `app.security.csp` | Same restrictive policy as the web build's `_headers`, plus `frame-src sandbox: http://sandbox.localhost` for the local `format:html` runner iframe |

The `sandbox://` custom URI scheme (registered in `lib.rs`) serves the shared
runner HTML for `format:html` notes — an isolated local origin with a
permissive CSP, no network needed. Source of the HTML:
`backend-services/4-public-sites/sites-worker/src/runner.html` (compiled in
via `include_str!`).

## Secrets

None in config or env — the sensitive values (the wrap-key bytes and the login
`authHash` used for passwordless unlock) are never static secrets; they're
derived at runtime from the user's password and sealed into the OS-native
keystore via the `keyring` crate, not stored in any file this repo tracks. See
`table.md`'s "OS keystore" section.
