# Desktop / Mobile Shell — Tauri

The native Memoza client for Windows/macOS/Linux (and, on the same stack,
iOS/Android). It **reuses the web app's `crypto` and `api` modules verbatim** —
one audited crypto implementation across every platform — and adds the two
things a browser can't safely do: an **offline-first local store** and a
**convenience unlock backed by the OS keystore / biometrics**. Crypto spec:
`docs/architecture/README.md`. Web app it shares code with:
`docs/architecture/frontend-web/README.md`.

## Why Tauri (not Electron / native)

- **Single crypto implementation.** The security-critical `crypto` module is
  WebCrypto TypeScript; hosting the web frontend in a WebView reuses it as-is.
  A native rewrite (C#/Swift/Kotlin/Dart) would fork the encryption into
  multiple audit surfaces — the one thing an E2EE product must not do.
- **Simplicity + performance branding.** Tauri ships a few-MB binary on the
  system WebView (WebView2 on Windows), not a ~150 MB bundled Chromium at high
  idle memory (Electron).
- **One stack for desktop and mobile.** Tauri 2 targets desktop and iOS/Android,
  so the same Rust shell + TS core serves every client.

## Component view

Tauri 2 shell = a thin **Rust core** + the **system WebView** rendering the
shared TS frontend. The frontend is the same Vite app as web, with two module
seams swapped for native implementations:

| Layer | Web | Desktop/mobile (this shell) |
|---|---|---|
| `crypto`, `api` | shared | **shared, unchanged** |
| `store` | in-memory, online-only | **SQLite-backed, offline-first** (local ciphertext cache + durable write queue) |
| unlock | password every session | **OS-keystore / biometric** convenience unlock after first password unlock |

The Rust core owns only what the WebView can't: the local SQLite database,
secure OS-keystore access, the auto-updater, native file dialogs (import/export),
and deep links (password-reset URLs). All crypto, rendering, search, and sync
logic stay in the shared TS frontend.

## Offline-first store (Rust + SQLite)

This is the offline stack deliberately **kept out of the web app**:

- A local SQLite database mirrors the server shape — **ciphertext and wrapped
  keys only**, never plaintext or raw keys (same trust boundary as D1).
- A **durable write queue** persists pending mutations (create/edit/pin/share/
  comment) and drains to the API, retrying on the next trigger (enqueue,
  reconnect, refocus) after a failure — surviving restarts and crashes.
- Pull uses the notes service's keyset cursor (`GET /notes?since=`); creates use
  client-generated ids + idempotent `PUT`; a `409` resolves keep-both. This is
  the offline-first design already specified by the notes service — the desktop
  store is its client.
- **Full-body search** runs here (the local cache already holds every note), the
  feature the web client omits.

## Convenience unlock (OS keystore / biometrics)

The `crypto` module exposes a wrap/unwrap boundary; the shell hooks it so the
user unlocks without retyping the password each launch:

- On first unlock the user enters the password (derives `wrapKey`, unwraps
  `dek` + `privateKey` as before).
- The shell then seals a re-unlock secret in the **OS secure store** — Windows
  Hello / Credential Manager, macOS Keychain + Touch ID, or mobile biometric —
  gated by a biometric/OS prompt.
- Later launches unlock via that OS prompt; the password is still required
  after logout, on a new device, or as a fallback.
- Keys never leave the client and never persist unsealed; the OS keystore holds
  only the wrapping secret. Logout wipes the SQLite store and the keystore entry.

## Decisions

- **Tauri 2 over Electron and native rewrites** — smallest binary + system
  WebView (fits "simplicity + performance"), and it reuses the single audited TS
  `crypto` module. Rejected: Electron (bundle/memory weight); native C#/Swift/
  Kotlin/Dart (forks the encryption into multiple audit surfaces); Flutter
  (unifies mobile but still a Dart crypto rewrite).
- **`store` is a swappable seam, not a fork of the app** — web ships the
  in-memory online-only impl; desktop/mobile ship the SQLite offline-first impl
  behind the same interface, so `views` and `crypto`/`api` are shared unchanged.
- **Offline-first lives only in the native shell** — the browser stays memory-
  only for safety on public machines; the durable queue + local cache that make
  offline work belong where a trusted device runs.
- **OS keystore for convenience unlock, hooking the crypto boundary** — gives
  biometric/no-retype unlock without ever persisting an unsealed key; the
  keystore holds only the wrapping secret. Rejected: storing derived keys in a
  plain local file (recoverable at rest).
- **One Tauri codebase for desktop and mobile** — maximizes reuse of the audited
  core; a platform-specific mobile framework would re-fork crypto.
- **Latest stack**: Tauri 2, Rust stable, the same Vite + TypeScript frontend;
  SQLite via a Tauri SQL plugin, secure storage via the OS keychain, updates via
  the Tauri updater plugin.

## Implementation notes

- **The sealed "wrapping secret" is the raw `wrapKey` bits** (HKDF output,
  `deriveWrapKeyBits`/`importWrapKeyBits` in `frontend/core/crypto/kdf.ts`),
  base64-encoded and handed to a Rust `seal_secret` command over Tauri's IPC.
  This is the one place `core` derives a wrap key as raw bytes instead of a
  non-extractable `CryptoKey` — justified because the bytes never stay in JS
  memory past the single `invoke()` call; the OS keystore is the at-rest
  boundary from then on, matching "the OS keystore holds only the wrapping
  secret."
- **OS-keystore storage today; a true biometric *prompt* is a follow-up.** The
  Rust side uses the `keyring` crate (Windows Credential Manager / macOS
  Keychain / Linux Secret Service) via three commands — `seal_secret`,
  `unseal_secret`, `clear_secret` — which gives real OS-account-scoped,
  encrypted-at-rest storage. Actually gating that read behind a Windows Hello /
  Touch ID *prompt* needs additional platform-specific native bindings
  (`Windows.Security.Credentials.UI`, macOS `LocalAuthentication`) that weren't
  wired up here — documented gap, not built, same as CEK rotation.
- **Local `local_account` cache table** (`table.md`) stores the current
  user's `wrapped_dek`/`wrapped_private_key` (ciphertext, not key material) so
  biometric unlock works fully offline — no network call needed to re-obtain
  the envelope on a fresh launch.
- **Full-body search runs client-side over the local SQLite cache** — the
  store's `search()` first reuses `core/search.ts`'s title/tag match, then, for
  the local-only remainder, decrypts and checks each note body. This is the
  one `Store` method whose behavior meaningfully diverges from the web
  implementation (by design — see `frontend-web/README.md`'s "Search over
  title + tags only" decision).
- **`Store.listNotes()` / `Store.search()` are async in the shared
  interface** — SQLite access via the Tauri SQL plugin is IPC-based and
  therefore always asynchronous, unlike the web shell's synchronous in-memory
  `Map`. The interface (and the shared `views/listView.ts`) was written async
  from the start so both shells satisfy it identically.
- **Deep link scheme `memoza://`** registered via `tauri-plugin-deep-link` for
  password-reset links opened outside the app; `main.ts` translates an
  incoming URL into a hash-route navigation (the app is otherwise entirely
  hash-routed, matching the web shell).
- **Write-queue conflict handling.** A queued `update` op that resolves to a
  `409` (the owner edited the same note from another device before this queue
  entry drained) performs the same keep-both fork as the web shell: decrypt
  the queued ciphertext with the note's (unchanged) `cek`, create a new note
  with a fresh `cek`, and adopt the server's row for the original id.

## Known gaps (accepted for v1)

- No biometric *prompt* (see above) — OS-keystore storage only. Enabling/
  disabling the keystore-backed unlock itself (Settings → "Biometric / OS
  unlock") is wired; only the native Windows Hello / Touch ID gate on the
  keystore read is missing.
- No app icons committed (binary assets) — `tauri.conf.json` references
  conventional paths (`icons/32x32.png` etc.) that must be added before
  packaging, the same operational step as generating the real JWT/escrow
  keypairs.
- Not compiled/verified against a live Rust toolchain in this environment (none
  was available) — the Rust scaffold should be checked with `cargo check` /
  `tauri dev` before relying on it.
- Mobile (iOS/Android) targets, auto-update signing, and installer code
  signing are packaging steps out of scope for this pass.

## Changes

- 2026-07-10 (review) — Fixed logout/account-deletion to actually call
  `wipeLocalStore()` + `clearLocalAccount()` via a new shared `onLogout` hook
  on `AppContext` (previously exported but never invoked, so cached ciphertext
  and the sealed keystore secret survived logout). Wired
  `enableBiometricUnlock`/`disableBiometricUnlock` into a new Settings section
  via a `biometricControl` hook (previously dead code with no UI entry point).
- 2026-07-09 — Initial design: Tauri 2 shell reusing the web `crypto`/`api`
  core; SQLite offline-first `store`; OS-keystore / biometric convenience unlock.
- 2026-07-10 (implemented) — Built `frontend/desktop`: Rust core
  (`src-tauri/`) with SQL/dialog/deep-link/updater plugins and `keyring`-backed
  secure-store commands; the SQLite `Store` implementation (offline cache +
  durable write queue with 409 keep-both handling + full-body search); the
  biometric `UnlockProvider` hook now exposed by `frontend/core/views/app.ts`.
  `IMPLEMENTATION-PLAN.md` deleted; decisions and gaps recorded above and in
  `table.md`.
