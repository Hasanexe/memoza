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
- **`memoza://page/N` over `memoza://username/N` for private navigation** —
  the deep link is opened on *your own* installed app/account, so it doesn't
  need (or want) a username in it; `page/N` is shorter and the per-account
  scoping is the accepted, understood tradeoff (a link opened on the wrong
  account just shows that account's page N, or "no page here yet"). The
  public web link is the one that needs `username` — different mechanism,
  different constraint. Rejected: `memoza://username/N` (redundant — the app
  already knows who's logged in).

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
  hash-routed, matching the web shell). The notebook-shortcuts phase (below)
  extends this same handler with two more path shapes — no second deep-link
  registration needed.
- **Write-queue + published notes.** The local SQLite store and the queue hold
  **ciphertext only** — including for published notes. When the queue drains an
  `update` op for a note with `is_public`, the store decrypts the queued
  ciphertext with the note's `cek` **at drain time** and attaches the plaintext
  mirror fields `{title, body, format}` the notes service requires on a
  published-note `PUT` (see `docs/architecture/2-notes/README.md`, "Live
  mirror"). Plaintext still never persists at rest; it exists only for the
  outbound request.
- **Write-queue conflict handling.** A queued `update` op that resolves to a
  `409` (the owner edited the same note from another device before this queue
  entry drained) performs the same keep-both fork as the web shell: decrypt
  the queued ciphertext with the note's (unchanged) `cek`, create a new note
  with a fresh `cek`, and adopt the server's row for the original id.

## Notebook shortcuts — `.mmp` files + page/note deep links

The desktop-only piece of the notebook feature: a placeholder file droppable
into any Windows (later macOS/Linux) folder that opens directly to a page in
the notebook — e.g. a project folder gets a `.mmp` file instead of a loose
`.txt`. Implemented (see Changes) — still the one item in the notebook
feature that's native, platform-specific, and (like the rest of this shell)
can't be verified without a live Rust toolchain.

- **Two deep-link path shapes**, both routed through the same `memoza://`
  handler already used for password resets:
  - `memoza://page/<N>` — opens *your own* notebook to page `N`. Per-account:
    it means nothing (or the wrong thing) if opened while logged into a
    different account. Chosen anyway for the notebook feel — see Decisions.
  - `memoza://note/<uuid>` — opens a specific note by id, usable for sending a
    **shared** (not public) note to another Memoza user; it only resolves if
    the opener already holds a grant on that note (access is still fully
    grant-gated, this is just a pointer). Account-proof (the uuid means the
    same thing on any account) but not human-readable, which is why it's the
    share-link form and not the primary notebook-navigation form.
- **`.mmp` (MeMoza Page) files** — a small file (contents: a `memoza://page/N`
  or `memoza://note/<uuid>` URL, plus a friendly display name) that the
  desktop app registers as a file association at install time. Double-click →
  OS launches/focuses the Memoza desktop app → it reads the `.mmp` → navigates
  via the same deep-link handler as above. A native file-dialog "Create
  shortcut here…" action (Rust core, alongside the existing import/export
  dialogs) writes one into a folder the user picks.
- **Not the same as a public link.** `.mmp`/`memoza://` shortcuts are private
  navigation aids gated by your own account's grants; the public
  `app.memoza.io/<username>/<page_no>` URL (notes service design) is the
  anonymous-facing mechanism and needs no app installed.

## Known gaps (accepted for v1)

- No biometric *prompt* (see above) — OS-keystore storage only. Enabling/
  disabling the keystore-backed unlock itself (Settings → "Biometric / OS
  unlock") is wired; only the native Windows Hello / Touch ID gate on the
  keystore read is missing.
- Not compiled/verified against a live Rust toolchain in this environment (none
  was available) — the Rust scaffold should be checked with `cargo check` /
  `tauri dev` before relying on it.
- Mobile (iOS/Android) targets, auto-update signing, and installer code
  signing are packaging steps out of scope for this pass.

## Changes

- 2026-07-18 (implemented) — Committed the real app icon set to
  `src-tauri/icons/` (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico`,
  `icon.icns`, `icon.png`, Windows Store `Square*Logo.png`/`StoreLogo.png`),
  closing the "no app icons committed" gap above. Generated via
  `tauri icon <path>` from the canonical source now in the `memoza-design`
  skill (`app-icon.svg` — see that skill's README, "ICONOGRAPHY"); the same
  command also produced ready-to-use iOS (`icons/ios/AppIcon-*.png`) and
  Android (`icons/android/mipmap-*`) sets as a bonus even though neither
  mobile target exists yet — `frontend/android`'s `IMPLEMENTATION-PLAN.md`
  updated to point at this instead of describing it as missing. Fixed the
  Android adaptive-icon background color (`icons/android/values/
  ic_launcher_background.xml`, tool default was white) to the real dark token
  `#1E1C18`.
- 2026-07-18 (implemented) — Built the notebook-shortcuts phase and the
  mirror-at-drain write-queue delta designed below. `db.ts`'s `local_note`
  gained `page_no`/`is_public` columns (`CREATE TABLE` for fresh installs +
  guarded `ALTER TABLE` for upgrades); `sqliteStore.ts` threads them through
  `toSummary`/`createNewNote`/`saveNote` and adds `publish()` (reads the
  already-cached body from `local_note`, no network round trip, calls the API
  inline — not queued, matching `frontend-core`'s Changes). `queue.ts`'s
  `update` op carries `isPublic`; `applyOp` decrypts the queued ciphertext
  with the note's `cek` **at drain time** (fetching `wrapped_cek` from
  `local_note`, since the op itself never carries plaintext or key material)
  and attaches the plaintext mirror fields before the outbound `PUT`, exactly
  as specified. A queued `create` op's response `page_no` is now written back
  into `local_note` after it drains (previously nothing did this — a note
  created offline would have kept `page_no = NULL` forever once the sync
  fast-path stopped re-fetching it).

  Deep links: `main.ts`'s `onOpenUrl` handler now routes through
  `deepLink.ts`'s `resolveDeepLink()`, which recognizes `memoza://page/<N>`
  (resolves `N` against the caller's already-synced owned, non-deleted notes —
  `#/note/<id>` on a hit, `#/` otherwise) and `memoza://note/<uuid>` (routes
  straight to `#/note/<uuid>`, access still fully grant-gated by the normal
  `getNote` 404), alongside the pre-existing hash-carrying reset-link case.

  `.mmp` files: `create_shortcut` (Rust) writes a two-line file (`memoza://…`
  URL, display name) to a path chosen via the existing dialog plugin's
  `save()`; wired to a new toolbar action in `editorView.ts` (only rendered
  when `AppContext.createShortcut` is supplied — web leaves it `undefined`, so
  the button never appears there). `tauri.conf.json` registers `.mmp` as a
  file association (`bundle.fileAssociations`); a double-clicked `.mmp`
  launches the app with the file path as an argv entry, which a new
  `take_pending_mmp_url` command reads **once at startup** (not an emitted
  event — avoids the race of the frontend's listener not being registered yet)
  and the frontend resolves through the same `resolveDeepLink()` path.

  Still unverified against a live Rust toolchain (see "Known gaps" above,
  unchanged) — the Rust scaffold should be checked with `cargo check` before
  packaging.
- 2026-07-15 (security review) — Specified how the ciphertext-only write queue
  satisfies the published-note live mirror: decrypt with the `cek` at drain
  time and attach the plaintext mirror fields to the outbound `PUT`; plaintext
  never persists locally. Still design only.
- 2026-07-15 (design) — Added the deferred notebook-shortcuts phase:
  `memoza://page/N` and `memoza://note/<uuid>` deep links (extending the
  existing `memoza://` handler) and `.mmp` file-association placeholders for
  dropping a page shortcut into a native folder. Design now, build last —
  depends on the notes/auth/frontend-core notebook work; still unverifiable
  without a live Rust toolchain. Not yet implemented.
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
