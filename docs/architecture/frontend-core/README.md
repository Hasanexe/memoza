# Shared Frontend Core — `frontend/core`

Platform-agnostic TypeScript shared by `frontend/web` and (later)
`frontend/desktop`. Holds the one audited crypto implementation, the API
clients, the `store` contract, and every view — so both shells run identical
code except for how they persist data and unlock. Crypto spec (algorithms, KDF
params, envelope formats): `docs/architecture/README.md`. Client state:
`table.md`.

## Component view

| Module | Responsibility |
|---|---|
| `crypto/codec.ts` | base64/hex/UTF-8 helpers, AES-GCM seal/open, generic AES-GCM and RSA-OAEP key wrap/unwrap primitives (IV-prefixed, base64 transport) |
| `crypto/kdf.ts` | `deriveMasterKey`, `deriveAuthHash`, `deriveWrapKey`, and the generic HKDF→AES-key derivation reused for both the login `wrapKey` and the two recovery-key-derived wrap keys |
| `crypto/keys.ts` | DEK / RSA keypair / recovery-key generation, export, wrap/unwrap under `wrapKey` or a recovery-derived key, and the extractable→non-extractable session-sealing step |
| `crypto/note.ts` | per-note `cek` generation; seal/open for title, body, tags (AAD = note id) and comments (AAD = comment id); wrap/unwrap `cek` under the DEK (owner) or an RSA public key (share) |
| `crypto/session.ts` | module-scoped, memory-only session state: `userId`, `email`, unwrapped `dek`/`privateKey` (non-extractable `CryptoKey`s), the access token, and the cached `wrappedDek`/`wrappedPrivateKey` ciphertext (see `table.md`) |
| `crypto/jwt.ts` | reads the access token's own claims (`user_id`) client-side — no signature verification (the server already verified it; the client only needs to know who it is) |
| `api/client.ts` | `fetch` wrapper: attaches the bearer token, single-flight `/auth/refresh` on 401, typed `ApiError` (status + parsed body) |
| `api/auth.ts`, `api/notes.ts` | typed functions mirroring `api-auth-usage.md` / `api-notes-usage.md` one-to-one; move ciphertext and wrapped-key strings only, no crypto here |
| `store/types.ts` | the `Store` **contract** every view codes against (`sync`, `listNotes`, `getNote`, `saveNote`, trash/restore/purge, share/unshare, comments, `search`) — no persistence assumptions. `pinned` is gone; pin state lives in a note's `tags` |
| `search.ts` | in-memory substring match over title only, given a plain list of `{id, title}` |
| `views/*` | hash-routed screens (auth, list, editor, share dialog, settings, public reader) plus `dom.ts` (framework-free DOM builder, incl. `openDialog()`), `markdown.ts` (Markdown → sanitized HTML, lazy Mermaid), `app.ts` (router + the persistent shell, see below), `sidebar.ts` (chrome: brand/status row, a picker↔drill-in section state machine, settings, and the account row), `notePanel.ts` (the stateful note-list component, see below — instantiated twice per session, see "Persistent shell" below), `tagsEditor.ts` (the chip-style tag editor, including the control-tag typeahead), and `controlTags.ts` (the `CONTROL_KEYS`/`BOOLEAN_CONTROLS` registry — see "Notebook UI" below) |
| `connection.ts` | Tracks `navigator.onLine`, whether a valid access token is held, last successful sync, and a pending-write count; a subscribe/notify module (`connectionStatus()`, `onConnectionChange()`) — see "Persistent shell" below |

`frontend/web` supplies the in-memory `Store` implementation
(`frontend/web/src/store/memoryStore.ts`) and the Vite entry point; nothing
else. `frontend/desktop` will later supply a SQLite-backed offline `Store`
implementation behind the same interface — `crypto`, `api`, and `views` do not
change.

## Notebook UI — two-pane layout, page navigation, control tags, public reader

The "notebook" reframe: notes are also **pages** in a permanently-numbered
sequence (backend: `docs/architecture/2-notes/README.md`'s "Pages"), and
presentation state (color, format, pin) is expressed as **control tags**
instead of dedicated fields. All of this is view-layer work — zero new
`crypto`/`api`/`store` surface beyond the fields those layers already pass
through (`page_no`, `is_public`, and the `tags` array).

### Two-pane layout

`listView` and `editorView` stop being separate full-screen routes. Instead:

- **Left pane (`sidebar.ts`)**: a small state machine. Top level is
  My notes / Shared with me / Trash / Settings; picking one swaps in that
  section's list with a back button. Search box and tag-filter chips (now
  multi-select, filtering by content tags *and* control tags like `color:` or
  `pin`) live in this pane, above the list. List rows show title, color
  (from the `color:` control tag), and the first three **content** tags only
  — control tags never appear in the chip preview or the filter-by-content-tag
  UI (they get their own affordances).
- **Right pane** renders the open note at its own route, `#/note/<id>`, full
  height, full width of the remaining space (no centered max-width container
  for the *pane*) — but the **rendered Markdown/HTML preview's line length is
  capped** (~70–80ch) inside that pane; the raw edit textarea can stay full
  width. Wide panes, readable prose.

### Page navigation

The main pane's note view gains a page bar: `‹  page 26  ›`, where the number
is an editable field — type a number, Enter jumps to it.

- Prev/next/jump are pure client-side operations: sort the already-synced
  notes you own by `page_no`, step through them. No new API calls.
- **Deleted-page display** (see the notes service doc for the exact rules the
  client is implementing): `page N · deleted <date>` inside the retention
  window; `deleted` / `no page here yet` / `deleted or never existed` after
  the tombstone sweep, depending on where `N` falls relative to the synced
  high-water mark.
- Prev/next auto-skips a deleted page's gap to the next available one; jump-to
  a deleted page shows its deleted state instead of an empty editor.

### Control tags — a client-side registry, not new tags

Presentation/behavior flags (color, format, pin, and — later, cheaply — more)
are stored as ordinary strings inside the same encrypted `tags` array as
content tags, e.g. `["work", "color:green", "format:html", "pin"]`. The
**client** is the only thing that understands them, via one small registry
(`controlTags.ts`) that is the single source of truth:

```
CONTROL_KEYS = {
  color:  { single: true, values: ['red','orange','yellow','green','blue','purple'] },
  format: { single: true, values: ['md','html'] },
}
BOOLEAN_CONTROLS = ['pin']
```

- **Classification**: split each tag on the first `:`. Left side matches a
  `CONTROL_KEYS` entry → control tag (hidden from content-tag chips/filter,
  interpreted for color/format). No colon but the whole tag is in
  `BOOLEAN_CONTROLS` → boolean control. Anything else → ordinary content tag.
- **Single-value enforcement happens at write time**, in `tagsEditor.ts`: when
  the user sets `color:X`, the editor strips any existing `color:*` before
  adding the new one, so the array physically can't hold two. A `:` typed in
  the editor is the **typeahead trigger** — it lists known keys, then valid
  values for the matched key, and shows the *current* value first if one
  already exists (so it feels like editing, not adding).
- **`format` is freely changeable** (the body is stored identically either
  way; format only selects the renderer). `pin` toggles via the existing
  pin-icon affordance, which already writes the literal tag `"pin"`.
- Anything unrecognized (a typo like `color:banana`, or a tag from an older
  client) is just ignored by the classifier — graceful, no server involvement.

### Publish flow + public reader

- **Share dialog gains a "Make public" action.** Confirming shows a warning
  modal (exact copy, non-negotiable given the crypto spec's "Public pages"):
  *"Publishing stores this page as plaintext on Memoza's servers so anyone
  with the link can read it. This can't be undone — the only way to remove it
  is to delete the page."* On confirm, the client decrypts locally and calls
  `POST /notes/{id}/publish` (see `api-notes-usage.md`) with plaintext
  `{title, body, format}`.
- Once published, the note's own `/note/<id>` screen gains a **"Public"
  badge** + the shareable link (`app.memoza.io/<username>/<page_no>`,
  `.mmp` shortcut icon on desktop — see `frontend-desktop`). Every subsequent
  save of a published note **attaches the plaintext mirror fields**
  `{title, body, format}` alongside the ciphertext on `PUT` — the server
  can't decrypt, so the client supplies the public copy (the notes service
  rejects a published-note save without them). This happens inside
  `saveNote` when `is_public` is set; views don't do anything extra. Tags are
  never sent in plaintext. There is no "unpublish" control anywhere in the
  UI, only the existing trash/delete actions.
- **Restoring a trashed published note resumes public serving** (`is_public`
  survives trash). The restore action for a note with `is_public` shows its
  own warning modal before proceeding: *"This page was published. Restoring
  it puts it back on its public link immediately."*
- **The public reader is a distinct, unauthenticated view** at
  `#/…` for the app's own preview and a plain route for anonymous visitors
  (`app.memoza.io/<username>/<page_no>`, served without the sidebar or any
  authenticated chrome) — modeled on a full-page artifact/reader screen:
  title + rendered body (Markdown or, through the same DOMPurify path as the
  editor, HTML) and nothing else. **No comments, no tags, no share button, no
  edit affordance** — preview only, even for the owner viewing their own
  public link while logged out.

### Registration & activation screens

Matching the auth service's generic-202 + activation redesign
(`docs/architecture/1-user-access-management/README.md`, "Registration &
activation"):

- The **register form drops the username field** (email, password, language
  only — see "Internationalization (i18n)" below for the language picker).
  After submit it always shows the recovery key once (generated client-side —
  this is the only moment it exists), then a generic "check your email to
  activate" screen — the same screen whether or not the email already had an
  account.
- A new **activation route** (`#/activate?token=…`, opened from the emailed
  link) is where the user picks their permanent username: a debounced
  availability check (`GET /auth/username-available`, sending the activation
  token) drives a generic "available / not available" indicator, then
  `POST /auth/activate {token, username}`. On success → the login screen
  (activation never grants a session). A `409` keeps the user on the picker.
- The **login view** handles `403 "Not activated"` with a "check your email to
  activate" message, distinct from the generic `401` invalid-credentials error.

## Internationalization (i18n)

`i18n/` is a small, framework-free module: `languages.ts` lists the 32
supported locale codes (`LANGUAGES`, each with an English name, native name,
and `rtl` flag) plus `detectLanguage()` (matches `navigator.languages` against
the supported list, falling back to `en`); `en.ts` is the canonical English
string catalog (flat dot-keys like `'auth.email'`, typed as `StringKey`);
`locales/{code}.ts` (one file per non-English language) each export the same
key set translated; `index.ts` exposes `t(key, vars?)`, `getLanguage()`,
`setLanguage(code)`, `onLanguageChange(fn)`, and `initLanguage()`.

- **Lazy-loaded per language.** `index.ts`'s `loaders` map does
  `() => import('./locales/xx')` per code, so a session only ever downloads
  its own language's dictionary (plus English, bundled as the fallback) — the
  other 30 files never ship to that user. This is what keeps 32 languages
  cheap: the runtime/storage cost is one small JSON-like module per session,
  not thirty-two.
- **Storage and detection**: `initLanguage()` (called once by each shell's
  `main.ts`, before `mountApp()`) reads `localStorage`'s `memoza_language` key
  if present, otherwise calls `detectLanguage()`; `setLanguage()` persists the
  choice back to the same key and sets `document.documentElement.lang`/`dir`
  (`dir="rtl"` for `ar`/`he`/`ur`). This is a client-only default for
  anonymous/unauthenticated screens (login, register before submit) — once a
  session exists, the account's stored `language` (`docs/architecture/1-user-access-management/README.md`)
  is the source of truth and overwrites it (see below).
- **Server sync**: the registration form's language `<select>` defaults to
  `getLanguage()` and is included in `POST /auth/register`; `POST /auth/login`
  returns the account's stored `language`, applied via
  `setLanguage(result.language)` right after a successful unlock so a second
  device converges on the same choice; Settings' own language section calls
  `setLanguage()` immediately (for a responsive local UI) and best-effort
  `PUT /auth/language` in the background (failure is swallowed — a stale
  server-side preference has no real consequence, so this isn't worth a retry
  UI).
- **Re-render on change, not a reactive framework.** `app.ts`'s `mountApp`
  subscribes `onLanguageChange(() => { teardownShell(); render(); })` once, at
  mount — the one place that knows how to rebuild the whole authenticated
  shell. Every view function calls `t()` inline during its own render, so a
  full re-render (the same mechanism lock/logout already use) is sufficient;
  no per-component subscriptions. Changing the language on the registration
  screen re-renders that screen from scratch (via the same route), which
  resets typed field values — accepted as a minor rough edge rather than
  adding value-preservation machinery across a full rebuild.
- **Known gap — not translated**: `dom.ts`'s `relativeTime()` ("`25 min ago`"
  style strings used by the sync-status chip) and the literal color-tag names
  (`red`/`orange`/… shown as chip tooltips in `notePanel.ts`/`controlTags.ts`)
  are still English-only; they weren't part of the initial string inventory
  and are low-visibility enough to defer rather than block the rest of this
  build.
- **Translation quality**: the 31 non-English `locales/*.ts` files were
  machine-translated (by Claude) in one pass, not reviewed by native speakers.
  Good enough to ship the feature and validate the mechanism end-to-end;
  flagged here so a follow-up native-speaker review is a known, deliberate
  task — especially for the security-critical copy (recovery-key warning,
  publish warning, account-deletion copy) where precise wording matters most.

## Persistent shell, note panel, and mobile layout

`app.ts` no longer rebuilds the DOM on every hash navigation. `mountApp`
keeps a module-local `Shell` (the `.app-shell` element, the sidebar chrome,
the `.main` host, **two** `NotePanel` instances, and the main-pane mini top
bar — see below) that's created once on the first authenticated render and
reused for every subsequent list/editor/settings navigation within the
session; it's torn down only on lock/logout or a route leaving the
authenticated area (public reader, auth views). `ensureShell(section,
openNoteId)` — exposed on `AppContext` so `listView.ts`/`editorView.ts`/
`settingsView.ts` don't need their own shell-building code — updates the
active nav link and both note panels in place and returns a `ShellHandle`
(`main`, `setSection`, `setOpenNote`) instead of a fresh tree. Whenever
`openNoteId` is `null` and `section` isn't `'settings'`, `ensureShell`
itself clears `.main` and populates it with the main-pane top bar + the
main `NotePanel` — callers no longer render an "empty" placeholder or
special-case mobile.

`notePanel.ts`'s `createNotePanel(ctx)` lifts the note-list rendering that
used to live inline in `sidebar.ts` into a standalone stateful component
(`root`, `search` — the search `<input>`, exposed separately so a caller can
relocate it in the DOM — `mount(host)`, `setSection()`, `setOpenNote()`,
`refresh()`). Its search/tag-filter/scroll state lives in the component's
own closure, not rebuilt per navigation, and `setOpenNote()` only toggles a
CSS class on the affected rows — no list rebuild. On mount it renders
cached rows from `store.listNotes()` immediately and syncs in the
background; it never blanks an already-populated list behind a "Syncing…"
placeholder.

**Two independent `NotePanel` instances, two independent browsing
surfaces.** `ensureShell` creates a `sidebarPanel` (lives in `sidebar.ts`'s
drill-in section, see below) and a `mainPanel` (lives in `.main`, shown
whenever no note is open — on every screen size, not just mobile). Both
always mirror the same route section (`ensureShell`/`setSection` call
`setSection`/`setOpenNote` on both), so they never disagree about *what*
they're showing — they're just two independently-visible places to browse
it. This lets a desktop user either drill into the sidebar's own list or
use the main pane's mini top bar (`+` / My notes / Shared / Trash /
Settings, plus a collapse button for the sidebar) without needing the
sidebar at all; on narrow (≤760px) viewports `.sidebar` is hidden by CSS
entirely and the main pane's top bar + `mainPanel` is the sole navigation
surface (this is what "mobile" looks like, and it's the same code path as
desktop's optional browse mode, not a separate implementation).

**`sidebar.ts` is a picker↔section state machine, local UI state only.**
Top level is three big My notes / Shared with me / Trash buttons (a "parent
selection" screen — deliberately *not* shown together with a list, per
design feedback that the two didn't read as separate levels). Clicking one
navigates **and** drills the sidebar into that section: a `‹` back / `+`
new-page / search-title row (the search `<input>` is `sidebarPanel.search`,
moved out of the panel's own DOM into this row), then the tag-filter chips,
then the list, then (always, regardless of picker/section state) Settings
and an account row (email, spaced from a new logout button — see below).
The sidebar's own `‹` only collapses back to the picker; it's local,
sticky UI state, not a route change — the main pane keeps showing whatever
section is active regardless. A collapse/expand toggle (`chevronsLeft` /
`chevronRight`, persisted in `localStorage`) shrinks the sidebar to a bare
rail, useful once the main pane can browse on its own.

**Connection status** (`connection.ts`) is a small subscribe/notify module:
`connectionStatus()` combines `navigator.onLine` and whether a valid access
token is held into `offline` / `syncing` / `synced` (labeled "Offline" /
"Syncing…" / **"Online"**), plus a pending-write count pushed by the
desktop write queue. `sidebar.ts` renders it as a chip in the top brand row
(icon + "Memoza" + status), not next to the email anymore; `shareView.ts`
and `editorView.ts`'s comment controls disable (not throw) their
server-only actions while offline.

**Logout** (`authViews.ts`'s `performLogout(ctx)`, shared by the sidebar's
account-row button, a matching "Log out" action in `settingsView.ts` (the
only logout affordance on viewports ≤760px, where `.sidebar` is hidden —
Settings stays reachable there via the main pane's mini top bar), and the
lock screen's "Log out" link — which previously
only forgot the remembered email without ending the session, a latent bug
fixed by routing it through the same helper) warns first
(`confirmDialog`) if `connectionStatus().pendingCount > 0` ("this device has
unsynced changes, logging out now will lose them"), otherwise proceeds
straight away: best-effort `POST /auth/logout`, `ctx.onLogout?.()` (desktop
wipes its local SQLite store + OS-keystore secret), clears session state and
the remembered email, and navigates to a blank `/login` — never the
lock screen, so a logged-out device shows neither a stale email nor a
password field.

## Decisions

- **Extractable keys exist only transiently, never at rest.** A freshly
  generated `dek`/`privateKey`/`cek` must be extractable to produce its first
  wrapped copy (WebCrypto's `wrapKey` requires it), so each is converted to a
  non-extractable session copy immediately after (`sealDekForSession` etc.).
  Later operations that need to re-wrap an *existing* key (sharing a note to a
  new recipient, changing the password) cannot export the non-extractable
  session copy — instead they re-unwrap a fresh extractable copy from the
  already-known wrapped ciphertext (`unwrapCekWithDekExtractable`,
  `unwrapDekExtractable`, `unwrapPrivateKeyExtractable`), use it once, and
  discard it. This keeps the long-lived, XSS-exposed session state
  non-extractable while still supporting legitimate re-wrap flows. Rejected:
  keeping `dek`/`privateKey` extractable at rest (violates `SECURITY-RULES.md`
  directly).
- **`wrappedDek`/`wrappedPrivateKey` ciphertext is cached in session state**
  alongside the unwrapped keys, specifically to support the above — it's
  opaque server-issued ciphertext, not key material, so caching it carries
  none of the risk raw key bytes would. See `table.md`.
- **`views` live in `core`, not `web`** — the Tauri desktop shell renders the
  same DOM in a system WebView, so the UI code is exactly as reusable as
  `crypto`/`api`. Only the `store` implementation and the unlock mechanism
  (password vs. OS keystore) differ per shell.
- **One sanctioned `innerHTML` sink** (`views/markdown.ts`) — every other view
  builds DOM through `dom.ts`'s `h()` helper, so an XSS-via-note-content path
  can only exist in the one place that's DOMPurify-sanitized on every render.
- **`core` depends on Vite's `import.meta.env`** for build-time config
  (`VITE_API_BASE_URL`, `VITE_ESCROW_PUBLIC_KEY`) — acceptable because every
  consumer (web today, the Tauri shell later) builds with Vite; see
  `frontend/web`'s `variables.md`.
- **Control tags are a client-side registry over the existing encrypted `tags`
  array, not new note fields** — mirrors the notes service's own reasoning
  (client already decrypts every note, so classification is free; a plaintext
  column would leak presentation data for zero benefit). One registry
  (`controlTags.ts`) is the single source of truth for every view that reads
  or writes them, so adding a future control is a registry entry, not a schema
  change. Rejected: dedicated fields per control (schema/sync growth for
  something the client already has for free).
- **Public reader is a separate view with no shared chrome**, not the normal
  editor in a read-only mode — a published page is anonymous-facing, so it
  must never accidentally expose sidebar navigation, other notes, or
  authenticated actions. A distinct component makes that structurally
  impossible rather than a prop to remember. Rejected: `editorView` with a
  `readOnly`/`public` flag.
- **Mobile master-detail routing, not a drawer/overlay.** Below 760px the
  note list occupies the full `.main` pane (route `/`, `/shared`, `/trash`)
  and opening a note replaces it with the editor plus a back button — the
  same navigation model as desktop, just one pane visible at a time, reusing
  the single persistent `NotePanel` instance rather than a second list
  component or a slide-over. Rejected: a hamburger/drawer sidebar (extra
  component, extra state, and the existing back-button navigation already
  reads naturally on a phone).
- **No split editor/preview pane, on any screen size.** The eye-icon toggle
  that swaps the textarea and the rendered preview full-width is the only
  authoring mode; it doesn't change with the mobile work. A side-by-side
  split doesn't fit a phone width at all, and keeping one editing model
  across breakpoints avoids a second preview layout to maintain.
- **Full-bleed panes, capped prose width** — the two-pane layout uses the
  whole viewport (the left pane now carries search + filters + list, so it
  needs the room), but unrestricted line length in the rendered preview is a
  readability regression on wide monitors regardless of pane width. These are
  two different constraints (layout vs. typography) and are solved
  independently rather than picking one width for both.

## Known gaps (accepted for v1)

- **No "list current participants" in the share dialog.** The notes API has
  no endpoint that enumerates a note's grants/participants (by design — see
  `docs/architecture/2-notes/README.md`), so the share dialog only supports
  share-by-email and revoke-by-email (which resolves the email to a user id
  via the same authenticated public-key lookup used for sharing). A future
  participants-listing endpoint would need a matching backend change.
- **`kdf_iterations` is a compile-time constant on the client**
  (`config.ts`), not fetched per-user before login. The server currently
  whitelists registration to exactly one value, so this doesn't bite yet, but
  it means a future per-user iteration bump wouldn't be usable by existing
  clients without also shipping a pre-login lookup (which the crypto spec
  deliberately avoided to prevent a user-enumeration surface). Documented, not
  built.
- **Markdown insert-toolbar actions are line/selection-based, not a rich
  editor.** Bold/italic/heading/list/checklist/link/code wrap or prefix the
  current textarea selection — no undo grouping beyond the browser's own
  textarea undo stack, no smart re-toggle (clicking Bold on already-bold
  text wraps it again rather than stripping the markers).

## Changes

- 2026-07-20 (i18n) — Added the `i18n/` subsystem (32 languages) — see
  "Internationalization (i18n)" above for the full shape. Registration gained
  a language picker (auto-detected from the browser, changeable before
  submit, replacing the dropped `name` field — see the auth service's
  Changes); Settings gained a matching language section. Every view file
  (`authViews`, `settingsView`, `editorView`, `notePanel`, `sidebar`,
  `shareView`, `tagsEditor`, `publicReaderView`, `syncStatus`, `app`) had its
  hardcoded UI strings extracted into `t()` calls against the new catalog.
  `frontend/web/src/main.ts` and `frontend/desktop/src/main.ts` both gained an
  `await initLanguage()` before `mountApp()`.
- 2026-07-19 (navigation redesign) — Second UI pass on top of the same day's
  render-architecture work below:
  - **Sidebar became a picker↔section drill-in** instead of showing the
    My notes/Shared/Trash nav and the list together; **a second, independent
    `NotePanel` instance now lives in `.main`** and is shown by default
    whenever no note is open, on every screen size — see "Persistent shell,
    note panel, and mobile layout" above for the full shape. This replaces
    `listView.ts`'s old `main-empty` placeholder (removed, along with its
    CSS) and the old `showListInMain`/`panelInMain`/`mobileQuery` plumbing
    in `app.ts` and `ShellHandle` (mobile now gets the same "browse in
    main" behavior as desktop's new optional mode, via one code path, not a
    breakpoint-gated special case).
  - **Fixed a real bug while doing it**: on mobile, navigating from an open
    note back to the list never cleared `.main` — `NotePanel.mount()` just
    appended the panel, and `listView.ts` skipped `clear(main)` whenever
    `panelInMain` was true — so the old editor DOM stayed on top and the
    back action looked like it did nothing. `ensureShell` now always
    `clear()`s `.main` before repopulating it, which fixes this by
    construction (there's no path that appends without clearing anymore).
  - **Connection chip** moved from next to the session email to the top
    brand row (icon + "Memoza" + chip), and the `synced` state now reads
    "Online" instead of "Synced".
  - **Logout**: sidebar's account row gained a real logout button (spaced
    from the email, not jammed against it), and `settingsView.ts` gained a
    matching one (the only reachable one at ≤760px, where `.sidebar` is
    hidden) — both wired to a new shared `performLogout()` (see above),
    which also fixed the lock screen's logout link (previously forgot the
    remembered email but left the session live). This supersedes the
    2026-07-13 (navigation + icon pass) entry's "no logout button anywhere
    in `views/*`" note below — `rememberEmail: false` shells (web) still
    never show the lock screen, but any shell can now end a session
    explicitly.
  - **Desktop: no repeated password prompts.** `authViews.ts`'s
    `unlockWithPassword` now silently calls `ctx.biometricControl.enable()`
    after any successful password unlock (online or offline) if it isn't
    already enabled — previously this was an opt-in the user had to find in
    Settings. `renderLock` now attempts `unlockProvider.unlock()`
    immediately on mount when available, showing a brief "Unlocking…" state
    instead of a password form, and only falls back to the password field
    if that fails or no provider is available. Still the one sanctioned
    raw-key-bytes-at-rest exception (OS keystore only, see
    `frontend-desktop`'s `CLAUDE.md`) — no change to what's stored, only to
    when the client offers to use it.
  - **Editor toolbar** is now one row (`back` — a new double-chevron
    `chevronsLeft` icon, to read as "further back" than the sidebar's
    single-chevron section-back — then the page-jump cluster centered
    ("Page" label, `‹`, the page number field, `›`), then Preview/Share/
    Shortcut/Trash actions on the trailing edge) instead of a back link
    above a separate page bar above a separate action row. `dom.ts` gained
    `chevronsLeft` and a `logout` icon.
- 2026-07-19 (implemented) — Frontend render architecture + mobile pass, per
  `yes-its-so-bad-dapper-shell.md`'s plan:
  - **Persistent shell** (`app.ts`): replaced the "rebuild `.app-shell` from
    scratch on every `hashchange`" pattern with `ensureShell()`, built once
    per session and reused (see "Persistent shell, note panel, and mobile
    layout" above). `listView.ts`/`editorView.ts`/`settingsView.ts` no
    longer call `renderSidebar()`/`clear(root)` themselves — they render
    into the `main` host `ensureShell()` returns. `editorView.ts` dropped
    its three internal `clear(root)` calls; it clears only its own `main`
    content now. `sidebar.ts` shrank to chrome only (brand, nav, footer) and
    exports a `SidebarChrome` (`el`, `setActive()`, `restorePanel()`)
    instead of a bare element.
  - **`notePanel.ts`** (new) extracted from `sidebar.ts`'s old
    `renderSectionBody` — see above. Fixes: a tag filter no longer resets
    when opening a note (state lived in the old per-render closure);
    switching notes no longer blanks the list behind "Syncing…"; entry
    animations (`mz-rise` stagger, `.editor-view`'s `mz-fade`) were dropped
    from `.note-row`/`.editor-view` since they replayed on every navigation
    under the old full-rebuild model.
  - **`Store.sync()` gained an optional `force` parameter** with a 30s TTL
    guard in both `memoryStore.ts` and `sqliteStore.ts` (skipped unless
    forced; forced on the `online` event). `memoryStore.getNote()` now
    serves from cache when a decrypted body is already held (sync already
    nulls a note's cached body when its rev actually changes, so this is
    safe); `sqliteStore.getNote()` already read locally. Comments now load
    lazily on first expand of a collapsible "Comments" section instead of
    on every editor mount, except when `hasUnreadComment` is true. Tab-focus
    (`visibilitychange`) now calls the cheap `panel.refresh()` path instead
    of a full app rebuild — `mountApp()`'s returned `refresh()` is now
    shell-aware (`shell.panel.refresh()` if a shell exists, full `render()`
    otherwise), so `web/main.ts`/`desktop/main.ts` didn't need their own
    shell-awareness.
  - **Mobile**: `.sidebar{flex:none}` fixes the 360px-tall empty bar at
    ≤760px (`flex:0 0 360px`'s basis was being read as height once the
    sidebar became a row); `100vh`→`100dvh` on `#app`/`.app-shell`/`.sidebar`
    for mobile browser chrome; removed a dead `@media(max-width:560px)` note
    title rule (see "Known gaps" — no longer dead post-master-detail, kept
    removed anyway since the 1px difference is inconsequential); raised
    `.editor-body`/search/tag-editor input font sizes to 16px to stop iOS
    auto-zoom-on-focus. Tag chips gained a visible `×` remove button
    (`tagsEditor.ts`'s `chip()` root changed from `<button>` to a focusable
    `<span>` so the `×` `<button>` can nest inside it — a button can't
    contain interactive content).
  - **Editor input**: new Markdown insert-toolbar (`.markdown-toolbar`,
    bold/italic/heading/list/checklist/link/code — wraps or prefixes the
    textarea selection) shown at all widths, hidden together with the
    textarea while in preview mode. Six new line icons added to `dom.ts`'s
    `icon()` (bold/italic/heading/list/checkbox/code), matching the existing
    Lucide-style primitive-shape convention per the `memoza-design` skill's
    "use Lucide" guidance. Autosave now flushes on `blur`, `visibilitychange`,
    and `pagehide` (previously only the 4s debounce), and a `hashchange`-
    triggered teardown clears the pending timer and guards the one save-
    completion side effect that touches shared panel state (`setOpenNote`)
    behind an `active` flag, so a save for note A that resolves after the
    user has already navigated to note B can't re-highlight A in the list.
  - **Dialogs**: `dom.ts` gained `openDialog()` — a shared a11y wrapper
    (`role="dialog"`, `aria-modal`, focus trap, Escape, backdrop click,
    focus return to the trigger, optional `onClose`) now used by both
    `confirmDialog()` (now exported) and `renderShareDialog()`.
    `.dialog-overlay`/`.dialog` gained `overflow-y:auto` + a `max-height`
    so a tall dialog in landscape scrolls instead of clipping unscrollably.
    The raw `confirm()` in the trash-row purge action is now
    `confirmDialog()`; restore/purge/comment-post/comment-delete route
    success feedback through the existing `showToast()` instead of nothing
    or a banner. Export/import/password-change/comment-post buttons disable
    while their request is in flight.
  - **Offline password unlock** (desktop only — web has no local cache to
    unlock from): `authViews.ts`'s `unlockWithPassword` derives the
    credential locally first; if `navigator.onLine` is false, or
    `authApi.login` fails with a non-`ApiError` (a real network failure, not
    a 401/etc.), it unwraps the cached envelope via a new optional
    `AppContext.localAccount(email)` accessor and calls `setSession()`
    without an access token, rather than rethrowing. A wrong password is
    still rejected (`unwrapDek`'s AES-GCM auth tag fails) — not a security
    downgrade. Requires one prior online sign-in on that device (every
    vault is an account vault; there's no local-only vault to migrate from).
  - **`connection.ts`** (new) — see "Persistent shell, note panel, and
    mobile layout" above.
- 2026-07-18 (logo) — The logomark used by `dom.ts`'s `logoMark()`/`brand()`
  (rendered from `/logomark.svg`, supplied per-shell) changed from the flat
  single-color dog-eared page to the faceted mark now canonical in the
  `memoza-design` skill (`logomark.svg`/`app-icon.svg` — see that skill's
  README, "ICONOGRAPHY"): a diagonal warm-gradient sweep across the same page
  silhouette, fold cut to a dark tone, thin gold rim. No code change here —
  `logoMark()` just renders whatever `/logomark.svg` contains — but noting it
  since every shell's brand lockup picks it up automatically.
- 2026-07-18 (implemented) — Built the notebook UI + registration/activation
  screens against this README, closing out the 2026-07-15/16 design entries
  below. Key implementation calls not fully spelled out in the design:
  - **Two-pane layout**: `sidebar.ts` is now the left pane in full — nav
    (My notes/Shared/Trash) stays persistent at the top, and picking one loads
    that section's search box + tag-filter chips + note list directly beneath
    it in the same `<aside>` (no separate drill-down/back-button state
    machine — the persistent nav row already serves as "back"). `listView.ts`
    shrank to composing the shell and a right-pane empty state; `editorView.ts`
    now renders inside the same `.app-shell` as the sidebar instead of as a
    separate full-screen route, so the note list stays visible while a page is
    open. Settings keeps its own right-pane content, nav-only in the sidebar
    (no list to embed there).
  - **Deleted-page display** is a distinct render branch in `editorView.ts`
    (title + `page N · deleted <date>` + Restore), reached both from a trash
    row and from a page-bar jump landing on a known-but-deleted page number.
    "No page here yet" / "deleted or never existed" (unknown page numbers) are
    shown inline next to the page-jump input without navigating, since there's
    no note id to route to.
  - **`controlTags.ts` is imported by the `store` layer** (`memoryStore.ts`,
    `sqliteStore.ts`), not just `views`, to compute the `format` mirror field
    from the current tags at save time — the README's "zero new store surface
    beyond `page_no`/`is_public`/`tags`" held: `saveNote`'s signature is
    unchanged, `format` is derived, never a new parameter. `Store` gained one
    real new method, `publish(id): Promise<number>`, matching the one new API
    call.
  - **`publish()` is a direct, awaited call, not queued** — unlike other
    mutations, it needs to return a `page_no` for the UI to show a link
    immediately, and it's a deliberate, warned-before, one-way action, not the
    kind of background write the offline queue exists for. Same on desktop:
    `sqliteStore.publish()` reads the already-cached body from `local_note`
    (no network fetch needed) and calls the API inline.
  - **The account's own `username` wasn't returned anywhere** the client could
    read it (needed to build the shareable link) — added to `POST
    /auth/login`'s response and `crypto/session.ts`'s `Session` (see the auth
    service's Changes). Every `setSession`/`onUnlock` call site updated
    accordingly.
  - **Public reader routing**: the in-app hash route and the plain anonymous
    URL are the same route — `#/<username>/<page_no>` (checked before the
    `isUnlocked()` gate in `app.ts`, ahead of every other route). Safe by
    construction: every route keyword (`note`, `settings`, `shared`, `trash`,
    `reset`, `register`, `activate`, `share`, `publish`, `page`, …) is
    pre-seeded in `retired_usernames`, so no real username can ever collide
    with a reserved segment. `frontend/web/src/main.ts` does a one-time plain-
    path → hash translation (`/<username>/<page_no>` → `#/<username>/<page_no>`)
    on load so a freshly-opened anonymous URL still lands on the hash router;
    this needed `assets.not_found_handling: "single-page-application"` in
    `frontend/web/wrangler.jsonc` so the Worker serves `index.html` for that
    path instead of 404ing. New `PUBLIC_APP_ORIGIN` config (`config.ts`,
    `VITE_PUBLIC_APP_ORIGIN`, defaults `https://app.memoza.io`) builds the
    link text/href.
  - **`markdown.ts` gained `renderContent(host, source, format)`**, dispatching
    to the existing Markdown+Mermaid path or a direct DOMPurify-sanitized
    `innerHTML` for `format: 'html'` — still the one sanctioned `innerHTML`
    sink, just two branches in it now, used by the editor preview and the
    public reader alike.
  - **Known gap**: the sidebar's embedded note list has no mobile treatment
    yet — below the existing 760px breakpoint the sidebar still collapses to
    an icon-only top bar (pre-dating this change) and the list body is hidden
    there rather than redesigned into a mobile drill-down. Desktop/wide-web
    only for now.
- 2026-07-16 (design) — Registration/activation UI redesigned to match the
  auth service: no username at register, generic "check your email" screen, a
  new `#/activate` route with the username picker (token-gated availability
  check), and a distinct "Not activated" login state. See "Registration &
  activation screens". Design only.
- 2026-07-15 (security review) — Publish flow updated to the client-supplied
  live mirror: `saveNote` attaches plaintext `{title, body, format}` on every
  `PUT` of a published note (tags never in plaintext); restore of a published
  note gains its own warning modal (restoring resumes public serving). Still
  design only.
- 2026-07-15 (design) — Added the notebook UI: two-pane layout (persistent
  `sidebar.ts` list pane + a `#/note/<id>` main pane, full-bleed with a
  capped preview reading width), page navigation (prev/next/jump, deleted-page
  states, driven by the notes service's new `page_no`), a client-side control-
  tag registry (`controlTags.ts` — color/format/pin, single-value replace,
  `:`-triggered typeahead in `tagsEditor.ts`), and the publish flow + a
  separate, chrome-free public reader view (see the notes service's "Public
  pages"). Design only; not yet implemented.
- 2026-07-14 (polish) — `.editor-body` and `.tag-chips` now use a themed thin
  scrollbar (`scrollbar-color`/`::-webkit-scrollbar*`, warm tokens) instead of
  the browser default. The tag bar's fade is now scroll-aware — it only shows
  while clamped *and* there's more below the visible area (was previously a
  fixed CSS mask that could show even on a single short row); the bar is also
  wheel-scrollable while clamped, not just expandable via the button.
- 2026-07-14 — Pin folded into tags: `Store.setPinned` and `pinned` are gone;
  pinning is the literal tag `"pin"`, saved through `saveNote` like any other
  tag. New `views/tagsEditor.ts` — a chip-style editor (`renderTagsEditor`)
  shared by the note editor: Space/Enter/`,` commit the current word as a tag
  (so a tag structurally can't contain a space), paste splits on
  commas/whitespace, click focuses/selects a chip and Backspace/Delete removes
  it, double-click pops a chip back into the input for editing, and a leading
  pin-toggle icon adds/removes `"pin"` and reports the change as `immediate`
  so the caller can save right away instead of waiting for the debounce.
  `search.ts` narrowed to title-only (tag filtering is the list view's own
  chip bar, a separate concern). `DecryptedNoteSummary.pinned` replaced by
  `hasUnreadComment` (see `docs/architecture/2-notes/README.md`'s Changes for
  the backend side: `note.last_comment_at` / `note_grant.last_viewed_at`).
  This also resolves the 2026-07-13 (wordmark) flag below — the
  `memoza-design` skill's README now says "Memoza" too (see its own Changes).
- 2026-07-10 — Initial implementation: `crypto`, `api`, `store` interface,
  `search`, and all views built per `frontend/web/IMPLEMENTATION-PLAN.md`
  (now deleted). Extracted into `frontend/core` from the start so
  `frontend/desktop` can reuse it unchanged.
- 2026-07-10 (simplification + bugfix) — Register, password-change, and
  password-reset each re-implemented "derive credentials/wrap keys under a
  password" slightly differently; extracted `deriveCredential` (authHash +
  wrapKey from a password) and `buildPasswordEnvelope` (also wraps an existing
  `dek`/`privateKey`) into `crypto/keys.ts`, used by all three flows now. While
  unifying them, found that password-reset's confirm step unwrapped `dek`/
  `privateKey` as **non-extractable** and then tried to wrap them again for
  the new password — `crypto.subtle.wrapKey` requires the source key to be
  extractable, so this would have thrown at runtime. Fixed by unwrapping via
  the already-existing `unwrapDekExtractable`/`unwrapPrivateKeyExtractable`.
- 2026-07-13 (brand redesign) — Rewrote `views/styles.css` to the Memoza
  "Ink & Paper" brand (`.claude/skills/memoza-design`): warm cream + clay
  tokens with a warm dark mode, self-hosted variable fonts, and the signature
  tactile moments — 3D "shelf" buttons, note **cards**, segmented tabs, pill
  `#tags`, serif titles + mono meta, and a fully branded Markdown preview.
  Added `dom.ts` helpers `logoMark()`/`brand()` (the dog-eared-page logomark
  lockup) and `showToast()`. The editor's "Move to trash" now plays a short
  tear-off animation and shows a 5s **Undo** toast (backed by the existing
  trash/restore lifecycle) instead of a blocking `confirm()`. No API,
  data-model, or crypto change — presentation plus that one delete-UX change.
  Views reference the fonts and logomark by absolute path (`/fonts/*.woff2`,
  `/logomark.svg`); each shell supplies those assets (web ships them under
  `public/`).
- 2026-07-13 (navigation + icon pass) — Restructured the authenticated app
  around a persistent left **sidebar** (new `views/sidebar.ts`): My notes /
  Shared with me / Trash / Settings, an icon-only "New page" action, and the
  session email — shown on the list and settings screens (the editor stays a
  focused, chrome-light writing view without the sidebar). Added an inline-SVG
  icon set (`dom.ts` `icon()`), built via `createElementNS` (never
  `innerHTML`, per the hard rule) since no icon CDN is reachable under the
  strict CSP; used for the sidebar nav and for the editor's back/preview
  (eye↔pencil)/pin/share/trash actions, which are now icon-only with
  `aria-label`/`title` instead of text, and now share one consistent
  `icon-btn` style (previously Preview used the `ghost` variant while
  Pin/Share used the plain default — inconsistent).
  **Fixed a real bug**: the My notes/Shared/Trash tabs never actually
  switched — `tab` was a `let` re-declared inside the same `renderContent()`
  that the tab buttons re-invoked, so every click silently reset it back to
  `'mine'` before rendering. Fixed by making the tab a **route** (`/`,
  `/shared`, `/trash`, wired in `app.ts`) instead of in-component state, so
  each is a fresh, correctly-scoped render — the bug class can't recur.
  Tag-chip filtering is now **multi-select** (AND across all selected tags,
  narrowing) instead of one-at-a-time.
  Added `AppContext.rememberEmail` (default `true`, preserving existing
  behavior): when `false`, the client never writes the last-used email to
  `localStorage`, so the quick-unlock ("lock") screen and its logout link
  never appear — login always asks for the full email + password. This is
  gated per-shell rather than changed globally because
  `frontend/desktop`'s biometric/OS-keystore unlock (see
  `docs/architecture/frontend-desktop/README.md`) depends on that same
  stored-email + lock-screen mechanism to know which account to unlock;
  `frontend/web` opts out (see its own Changes entry) while desktop keeps the
  default. There is now no logout button anywhere in `views/*`; ending a
  session on a shell with `rememberEmail: false` is just closing/reloading
  the tab, since nothing is persisted to log out of.
- 2026-07-13 (wordmark) — `brand()`'s wordmark text is now "Memoza" (capital
  M) per explicit product direction, diverging from
  `.claude/skills/memoza-design`'s "lowercase wordmark" rule — flagged, not
  silently changed; the skill file itself is unchanged pending a decision on
  whether to update it to match.
- 2026-07-20 (autosave rework + sync indicator) — Four autosave defects fixed
  in `views/editorView.ts`:
  - **Half-typed tags were being committed by autosave.** `save()`
    unconditionally called `tagsEditor.flushPendingInput()`, which commits
    whatever text sits in the tag input. A debounce started by an *earlier*
    title/body edit would therefore turn a partly-typed tag into a chip
    mid-keystroke. `save()` now takes `flushTags` and defaults to
    `tagsEditor.getTags()`; only the teardown paths (`hashchange`, `pagehide`,
    `visibilitychange → hidden`) flush, because those are the cases where the
    tag input's own `blur → commitInput` listener does *not* fire (removing a
    focused element fires no blur event). Typing in the tag field already never
    triggered a save — only committing a tag calls `onChange` — so that side
    needed no change.
  - **The full note index was rebuilt on every save.** `refreshPageBar()` calls
    `store.listNotes()` (decrypt + sort of every note); it ran after each
    autosave, i.e. every ~4 s while editing. It now runs only when `pageNo`
    actually changes — in practice the first save of a new note.
  - **Failed saves retried forever at a flat 4 s** with no user-visible
    affordance. Retries are now exponential (4 s doubling, capped at 60 s) and
    the status line offers an explicit "Retry now" button, which resets the
    backoff.
  - `AppContext` gained `refresh` so views can re-render after a manual sync.
- 2026-07-20 (last-sync indicator) — The sidebar connection chip became a
  `<button>` that shows a relative time ("just now", "25 min ago") instead of
  the word "Online", with a refresh glyph that fades in on hover and spins
  while syncing; clicking it forces `store.sync(true)`. Deliberately **no
  polling**: the label re-renders from the locally held `lastSyncAt` on a 30 s
  interval and on every `onConnectionChange` emit — it never calls the API to
  find out when it last synced. `connection.ts` gained `markSynced()` for that,
  fired where a network round-trip actually succeeds (web: a successful
  `updateNote`; desktop: a successful write-queue drain), *not* at save time —
  on desktop a save only reaches the local SQLite store and the queue, so
  treating it as "synced" would be a lie. The visible label carries no "click
  to sync" text by product direction; the affordance is the hover/cursor state,
  with the explicit wording living in `aria-label`/`title` for screen readers.
- 2026-07-20 (navigation + lock, second pass) — Sidebar became a permanent
  64px **icon rail**: brand mark, `+`, the three section icons, then settings
  and (native only) lock pinned to the bottom. The collapse/expand buttons and
  the `sidebarCollapsed` persistence are gone — there is no open/closed state
  any more. The rail no longer hosts a `NotePanel`: search, tag filter, and the
  note list live only in `.main`, so `ensureShell` now builds **one** panel
  instead of two (the second instance was decrypting and rendering the same
  list twice on every navigation). The account row moved out of the rail — the
  signed-in email now appears only in Settings → Account, since 64px cannot
  show an address.
- 2026-07-20 (lock vs log out) — Two distinct actions, native only:
  - **Lock** (`lockSession`) clears the in-memory session and nothing else —
    email, `local_account`, SQLite notes, and the write queue all survive, so
    the unlock screen asks only for a password. This is exactly what an app
    restart already did; the button just makes it available on demand.
  - **Log out** (`performLogout`) additionally revokes the refresh token, runs
    `onLogout` (wipes the local store), and forgets the saved email. On native
    it now always confirms first, stating that local data will be deleted and
    pointing at Lock as the non-destructive alternative.
  `performLogout` became async and reads the pending-write count from the new
  optional `Store.pendingWriteCount()` rather than the in-memory counter. That
  counter is only populated once a session exists, so it was always `0` at the
  unlock screen — meaning logging out from there silently destroyed unsynced
  writes without ever showing the warning. Web has no queue and falls back to
  the in-memory value.
- 2026-07-20 (merged save/sync indicator) — Save state and sync state are now
  one control, per product direction that they describe the same thing.
  `connection.ts` gained a `saveState` field (`idle`/`unsaved`/`saving`/
  `error`) which `editorView` drives via `markSaveState()`; the shared
  `views/syncStatus.ts` renders whichever is more urgent — an in-flight save
  wins, otherwise it shows offline/pending or the relative last-sync time.
  Clicking forces a sync. Still no polling: the label re-renders from local
  state on a 30 s tick and on every connection event.
  It is currently mounted in **three** places at once — `rail`, `panel`, and
  `page` variants — deliberately, so the placements can be compared in a real
  build before one is chosen. **Two of the three should be deleted once picked.**
  The editor keeps a separate small notice line for the two things the merged
  indicator cannot express: the "saved as a new copy" conflict message and the
  "Retry now" button.
- 2026-07-20 (`platform` flag) — `AppContext.platform` (`'web' | 'native'`)
  replaces inferring the shell from which optional callbacks happen to be
  present. Native-only affordances (lock, the destructive-logout warning) key
  off it; mobile-vs-desktop stays a CSS breakpoint concern, since at ≤760px the
  rail is hidden entirely and the lock button moves to the main top bar and the
  editor toolbar.
