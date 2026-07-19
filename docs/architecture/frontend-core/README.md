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
| `views/*` | hash-routed screens (auth, list, editor, share dialog, settings, public reader) plus `dom.ts` (framework-free DOM builder), `markdown.ts` (Markdown → sanitized HTML, lazy Mermaid), `sidebar.ts` (persistent nav + list pane), `tagsEditor.ts` (the chip-style tag editor, including the control-tag typeahead), and `controlTags.ts` (the `CONTROL_KEYS`/`BOOLEAN_CONTROLS` registry — see "Notebook UI" below) |

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

- The **register form drops the username field** (email, name, password only).
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
- **The sidebar's embedded note list has no mobile layout.** Below the
  existing 760px breakpoint the sidebar collapses to an icon-only top bar
  (pre-dating the notebook redesign); the search/filter/list body now living
  in that same pane is simply hidden there rather than given its own
  mobile drill-down. Desktop/wide-web only until a mobile-specific pass.

## Changes

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
