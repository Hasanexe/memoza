# Variables — desktop shell

## Build-time (Vite `.env`, see `frontend/desktop/.env.example`)

| Var | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Base URL the API clients call; defaults to `https://api.memoza.io` if unset |
| `VITE_ESCROW_PUBLIC_KEY` | Published escrow public key (PEM); if unset, `convenient` recovery mode is hidden |

## Native config (`frontend/desktop/src-tauri/tauri.conf.json`)

| Key | Purpose |
|---|---|
| `identifier` | `io.memoza.desktop` — app bundle id, also the OS-keystore service scope prefix |
| `plugins.deep-link.desktop.schemes` | `memoza` — the custom URL scheme used for password-reset deep links |
| `plugins.updater` | Disabled (`active: false`) until a real update endpoint + signing key exist |
| `app.security.csp` | Same restrictive policy as the web build's `_headers` |

## Secrets

None in config or env — the one sensitive value (the wrap-key bytes used for
biometric convenience unlock) is never a static secret; it's derived at
runtime from the user's password and sealed into the OS-native keystore via
the `keyring` crate, not stored in any file this repo tracks. See `table.md`'s
"OS keystore" section.
