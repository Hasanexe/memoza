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
| unlock | password every session | **OS-keystore passwordless unlock**, always on after the first password sign-in; the **Lock** button is the only way to require the password again |

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
  reconnect, refocus) after a failure — surviving restarts and crashes. A
  failed drain also schedules its own 15s backoff retry (`queue.ts`) so a
  transient failure can't leave writes parked until the next trigger fires.
- Pull uses the notes service's keyset cursor (`GET /notes?since=`); creates use
  client-generated ids + idempotent `PUT`; a `409` resolves keep-both. This is
  the offline-first design already specified by the notes service — the desktop
  store is its client.
- **Full-body search** runs here (the local cache already holds every note), the
  feature the web client omits.

## Passwordless unlock (OS keystore)

Passwordless unlock is **the design, not an option** — after the first password
sign-in the device unlocks silently on every launch, and the only way to require
the password again is the **Lock** button. There is no opt-in/opt-out UI.

- On first unlock the user enters the password (derives `wrapKey`, unwraps
  `dek` + `privateKey` as before). `frontend/core/views/authViews.ts`'s
  `unlockWithPassword` then calls `ctx.sealDeviceUnlock(password)` after **any**
  successful password unlock (online or offline).
- `sealDeviceUnlock` (`unlock.ts`) derives the master key once and seals **two**
  secrets in the OS secure store (Windows Credential Manager, macOS Keychain,
  mobile keystore): the `wrapKey` bits (`account = wrapkey`) and the login
  `authHash` (`account = authhash`). It also clears the `locked` flag.
- Later launches auto-unlock: `renderLock` sees `unlockProvider.isAvailable()`
  true (a cached `local_account` exists and `locked = 0`), shows a brief
  "Unlocking…" screen, and calls `unlockProvider.unlock()`, which unseals
  `wrapKey`, unwraps the keys, and `setSession()`s.
- **Staying online without the password.** Because passwordless unlock performs
  no `/auth/login`, it obtains no access token on its own; `unlock()` therefore
  calls `ensureOnline()`, which unseals the stored `authHash` and silently calls
  `login(email, authHash)` to get a fresh access token. `ensureOnline()` also
  runs from `main.ts` on reconnect/refocus, so a session that unlocked offline
  comes back online on its own. If `authHash` is absent or login fails (e.g. the
  password was changed on another device), the app stays offline until a password
  sign-in — it does not error.
- **Lock.** The Lock button (`lockSession`) calls `ctx.onLock()` →
  `lockDevice()`, which sets `local_account.locked = 1`, then clears the session.
  While `locked = 1`, `isAvailable()` returns false so the password form shows;
  the next successful password unlock clears the flag and resumes passwordless.
  The flag is persisted, so Lock survives an app restart.
- Keys never leave the client and never persist unsealed; the keystore holds only
  the wrapping secret and the login credential. Logout wipes the SQLite store and
  both keystore entries.
- **Security note.** Adding `authHash` to the keystore does not widen the blast
  radius: the keystore already holds `wrapKey`, which decrypts every note; the
  `authHash` only authenticates to the zero-knowledge server and can decrypt
  nothing. The threat model is "OS-user access = note access" — Lock is a privacy
  gate, not a cryptographic barrier.
- **The keystore read is ungated.** The sealed secrets are readable by anything
  running as the signed-in OS user; a true biometric *prompt* (Windows Hello /
  Touch ID) remains a follow-up.

## Offline password unlock

Independent of biometrics: typing the password with no network reachable
still works, **as long as this device has signed in online at least once**
(`local_account` — see `table.md` — must already hold this email's wrapped
`dek`/`privateKey`). `frontend/core/views/authViews.ts`'s
`unlockWithPassword` derives the credential locally first; if
`navigator.onLine` is false, or the login request fails with a real network
error (not a 401 or other server response), it unwraps the cached envelope
via `AppContext.localAccount(email)` — backed by `unlock.ts`'s
`getLocalAccountFor()` — and calls `setSession()` without ever setting an
access token, instead of surfacing the network failure. A wrong password is
still rejected: `unwrapDek` fails its AES-GCM auth tag exactly as it would
online, so this path adds no new attack surface. The biometric provider
above already proved the zero-network unlock flow works end-to-end; this is
the same envelope, reached via the password instead of the OS keystore.

**Connection status.** `frontend/core/connection.ts` combines
`navigator.onLine` and whether a valid access token is held into
`offline`/`syncing`/`synced`, merged with the editor's save state into the
single control described in `docs/architecture/frontend-core/README.md`
(`views/syncStatus.ts`) and currently mounted in three candidate placements
pending a choice. While offline,
`shareView.ts` and the editor's comment controls
disable their server-only actions (share, unshare, publish, post/delete
comment) instead of throwing — the write queue above already makes
share/unshare/comment mutations safe to queue while offline, but the UI
guard keeps the affordance itself honest rather than relying on every
`Store` method's offline behavior matching. The chip's pending count reads
`write_queue`'s row count (`queue.ts`'s `refreshPendingCount()`, called after
every enqueue and after every drain step) — the `attempts`/`last_error`
columns were already written per failed drain but never surfaced until now.

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
feature that's native and platform-specific.

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
- ~~Not compiled against a live Rust toolchain~~ — no longer true as of
  2026-07-20: the shell is built and used regularly via
  `npm run tauri build -- --bundles nsis`. Runtime behavior is exercised by the
  maintainer's own daily use; there is still no automated test suite.
- Mobile (iOS/Android) targets, auto-update signing, and installer code
  signing are packaging steps out of scope for this pass.

## Changes

- 2026-07-21 (redesign) — **Passwordless-by-design; opt-in toggle removed.** The
  Settings → "Skip password on this device" section is gone, along with the
  `biometricControl` hook and `enableBiometricUnlock`/`disableBiometricUnlock`/
  `isBiometricEnabled`. Passwordless unlock is now always on after the first
  password sign-in, and the **Lock** button is the only way to require the
  password again. New wiring: `AppContext.sealDeviceUnlock(password)` (seals
  `wrapKey` **and** the login `authHash`) replaces `biometricControl.enable`;
  `AppContext.onLock()` → `lockDevice()` sets the new `local_account.locked`
  flag (replacing `biometric_enabled`, dropped via best-effort `ALTER … DROP
  COLUMN`); `unlockProvider.isAvailable()` now gates on `locked = 0`. Fixes
  "passwordless stays offline forever": `unlock()` and the reconnect/refocus
  handlers in `main.ts` call the new `ensureOnline()`, which unseals `authhash`
  and silently `login()`s to obtain an access token — see "Passwordless unlock".
  Requires a Rust rebuild only if the keystore backend features changed (they
  did not); the second keystore account (`authhash`) uses the existing generic
  `seal_secret`/`unseal_secret` commands unchanged.
- 2026-07-21 (bugfix) — Convenience unlock never actually persisted: `keyring`
  was declared with no store feature, so keyring 3 fell back to its in-memory
  **mock** store. `seal_secret` "succeeded" (so `biometric_enabled` was set to
  `1`), but the entry vanished on restart and `unseal_secret` threw "No matching
  entry found in secure storage" → the app re-prompted for the password every
  launch. Fixed by enabling the real backends
  (`keyring = { features = ["apple-native", "windows-native"] }`). Because
  existing installs carry a stale `biometric_enabled = 1` pointing at an entry
  that only lived in the mock store, `frontend/core`'s `renderLock` now clears
  the flag (`biometricControl.disable()`) whenever automatic unlock fails, so
  the password fallback re-seals into the real keystore — self-healing on the
  first sign-in after the fix. Requires a Rust rebuild.
- 2026-07-21 (bugfix) — A `.mmp`/`memoza://page` deep link opened from a **cold
  start** used to land on the notes list: `resolveDeepLink()` runs before the
  session is unlocked, so the page-number lookup returned `#/`, and the pending
  URL was consumed and discarded. `main.ts` now stashes any link that arrives
  while locked (`pendingDeepLink`) and hands `frontend/core`'s new
  `AppContext.takePendingRoute` hook back to the app, which resolves and
  navigates to it once — on the first render after the session unlocks (both
  the password and convenience-unlock paths). The already-running/unlocked case
  still resolves immediately. No Rust change.
- 2026-07-19 (navigation redesign) — Convenience unlock is now auto-enabled
  after the first password unlock instead of an opt-in Settings toggle (see
  "Convenience unlock (OS keystore / biometrics)" above) — no code change on
  this shell's side, the new call lives in `frontend/core/views/authViews.ts`
  and uses the existing `biometricControl`/`localAccount` hooks unchanged.
  Logout now goes through `frontend/core`'s new shared `performLogout()`,
  which still calls this shell's `onLogout` (wipes the SQLite store + the
  keystore entry) exactly as before. See `frontend-core/README.md`'s Changes
  for the full cross-shell navigation redesign.
- 2026-07-19 (implemented) — Offline password unlock, connection-status chip,
  and a write-queue backoff retry (see "Offline password unlock" above for
  the full mechanics). `unlock.ts` gained `getLocalAccountFor(email)`,
  wired into `mountApp()`'s new `localAccount` option in `main.ts`.
  `queue.ts`'s `drainQueue()` now schedules a 15s retry via `setTimeout` on
  failure instead of relying solely on the next enqueue/`visibilitychange`/
  `online` trigger, and calls a new `refreshPendingCount()` after every
  enqueue and every drain step/failure so `connection.ts`'s pending count
  stays live. `main.ts`'s `visibilitychange`/`online` handlers no longer
  call `store.sync()` directly — `app.refresh()` now does a TTL-guarded sync
  itself (see `frontend-core`'s Changes), so `online` explicitly forces one
  (`store.sync(true)`) instead.
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
- 2026-07-20 (write-queue correctness) — Three defects in
  `src/store/queue.ts`, the most serious of which was silently duplicating
  notes:
  - **Every other autosave forked a duplicate note.** `saveNote` baked
    `base_rev` into the queued payload from the local row, but a successful
    push never wrote the server's new `rev` back to `local_note` — only a
    later `sync()` did, and `SYNC_TTL_MS` is 30 s against a 4 s autosave. So
    push #1 succeeded (server `rev+1`, local unchanged), push #2 sent the same
    stale `base_rev`, got the `409` conflict body, and
    `forkConflictingUpdate()` dutifully created a "keep both" copy — of the
    user's own consecutive edits to one note. Fixed by making `local_note.rev`
    the single source of truth: the queued `update` op no longer carries
    `base_rev` at all, `applyOp` resolves it from the local row at drain time,
    and the server's returned `rev` is written straight back. This also removes
    the redundant full `getNote()` re-fetch that the next `sync()` performed
    for every note the user had edited (local/server `rev` now already agree).
  - **One permanently-failing op blocked the entire queue forever.** Any error
    `break`s the drain loop and retried at a flat 15 s with `attempts`
    incremented but never read, so e.g. a `share` to a deleted recipient
    stalled every later write indefinitely. Failures are now classified:
    statuses in `UNRETRYABLE_STATUSES` (400/403/404/409/413/422) set a new
    `write_queue.failed` flag and the drain **continues** past them; everything
    else (network, 5xx, 408, 429) retries with exponential backoff, 15 s
    doubling to a 5 min cap. `401` is deliberately *not* unretryable — the API
    client auto-refreshes, so an escaping 401 means the session died, which is
    fixed by re-authenticating, not by discarding the user's write.
  - **Redundant update ops now coalesce.** A queued, not-yet-in-flight `update`
    for the same note is superseded in place rather than appended, so a burst
    of autosaves drains as one request. The in-flight row is tracked
    (`inFlightId`) and never coalesced into, otherwise a save landing mid-drain
    would be deleted by the success path that follows.
- 2026-07-20 (account switch) — `saveLocalAccount()` overwrote the single
  `local_account` row on sign-in but left `biometric_enabled = 1` and the OS
  keystore holding the *previous* user's `wrapKey`, so biometric unlock for the
  new user unsealed the wrong key and failed the DEK unwrap. It now detects a
  changed `user_id` and clears the keystore entry, resets the flag (in the
  `ON CONFLICT` clause, so it is atomic with the row swap), and calls
  `wipeLocalStore()` — necessary because `local_note` queries are not scoped by
  owner, so the previous user's rows would otherwise surface as undecryptable
  entries. Known tradeoff: this discards any unsynced queued writes belonging
  to the previous account, which cannot be pushed without their session anyway.
- 2026-07-20 (error masking) — `getNote()` returned `null` for *every* failure,
  making a network/5xx error indistinguishable from a genuinely missing note
  ("Note not found" while simply offline). It now returns `null` only for a
  real `404` and rethrows otherwise, matching the web store's existing
  behavior.
- 2026-07-20 (auto-unlock is already implemented, but silently failing) —
  Product direction: the desktop app must never ask for a password on restart.
  The machinery for that already exists and no new code was needed —
  `renderLock` auto-unlocks through `UnlockProvider` when the OS-keystore key
  is present, and `maybeEnableBiometric` in `authViews.ts` already tries to
  seal it after **every** successful password unlock. It is nevertheless off in
  practice: on the maintainer's machine `local_account.biometric_enabled` is
  `0` and no `io.memoza.desktop` credential exists in Windows Credential
  Manager, so the seal has never succeeded. The Rust side looks correct
  (`seal_secret` is registered in `invoke_handler`, and the sealed value is a
  44-char base64 string, far under Credential Manager's 2560-byte blob limit),
  so the failure is on the JS side or in `keyring` at runtime — and it was
  invisible because `maybeEnableBiometric` swallowed it with
  `.catch(() => undefined)`. That catch now logs the underlying error instead,
  which should identify the cause on the next run. **Open item: confirm the
  seal actually succeeds; until it does, restarts will keep asking for a
  password.**
  Deliberately *not* added: a second auto-enable path in `desktop/main.ts`.
  Core already owns this, and duplicating it would create exactly the kind of
  two-sources-of-truth split that caused the `base_rev` duplicate-note bug.
- 2026-07-20 (threat model widened, recorded) — Storing the wrapKey in the OS
  keystore is no longer a niche opt-in; it is the mechanism that makes restarts
  passwordless, i.e. the intended default posture. Consequence: anyone who can
  use the signed-in OS account can open all notes on that device. This is the
  standard desktop-app tradeoff, but it is a real widening of
  `frontend/CLAUDE.md`'s "one narrow, deliberate exception" and was taken as an
  explicit product decision. The native Windows Hello / Touch ID gate on the
  keystore *read* remains unimplemented and is the follow-up that would restore
  a real barrier. The Settings section was renamed from "Biometric / OS unlock"
  to "Skip password on this device" because there is no biometric prompt today
  and the old label implied one.
