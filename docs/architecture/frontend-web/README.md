# Web Frontend — `app.memoza.io`

The Memoza web app: a static, **online-only** TypeScript app. It owns **all**
cryptography (the server only ever sees ciphertext and public keys — spec in
`docs/architecture/README.md`), all Markdown + Mermaid rendering, and
client-side search over title/tags. Offline-first and OS-keystore unlock are
**not** the web app's job — they belong to the Tauri desktop/mobile shell
(`docs/architecture/frontend-desktop/README.md`), which reuses this app's crypto/api core.
Client-side state: `table.md`. API contracts: `api-auth-usage.md`,
`api-notes-usage.md`.

## Component view

Static assets served on `app.memoza.io` (Cloudflare Workers static assets),
talking to `api.memoza.io`. No server-side rendering, no app server. The
platform-agnostic modules below live in a shared `frontend/core/`
(`crypto`/`api`/`views` + the `store` interface); `frontend/web/` adds only the
in-memory `store` impl and the app entry, and the Tauri shell later reuses
`frontend/core/` unchanged.

| Module | Responsibility |
|---|---|
| `crypto` | KDF (`masterKey`, `authHash`, `wrapKey`); DEK + RSA-OAEP keypair; wrap/unwrap of DEK, private key, and per-note CEKs (symmetric for owned, public-key for shared); note + comment encrypt/decrypt; recovery-key backup of DEK + private key — WebCrypto only |
| `api` | `fetch` wrapper: attaches the access token, transparent single-flight `/auth/refresh` on 401 (`credentials: 'include'`), maps errors |
| `store` | In-memory model of the synced notes/grants/comments (ciphertext + wrapped keys) and the plaintext search index. Nothing note-related is persisted |
| `views` | Auth (register/login/lock/reset), note list, editor/preview, tags, sharing, comments, trash, settings, export/import |

## Key UX flows

- **Register**: enforce the sole password rule (**≥ 10 characters**), derive
  keys, generate DEK + RSA keypair + recovery key, submit the envelope; then a
  blocking screen showing the recovery key once with a download button and an
  explicit "without this, a forgotten password means your notes are gone
  forever" acknowledgement.
- **Unlock model (memory-only)**: after login the unwrapped `dek` and
  `privateKey` live **only in memory** as non-extractable `CryptoKey`s; the
  access token is in memory too. Nothing is persisted, so a refresh or a new tab
  starts locked: the app re-authenticates via the httpOnly refresh cookie and
  shows the **lock screen** (email cached for salt, password only) to re-derive
  `wrapKey` and re-unwrap the envelope. This is deliberate — the web client is
  meant for quick access on any machine, including public ones, and leaves no key
  material or note data behind. The convenient persistent unlock (OS keystore /
  biometrics) is the desktop/mobile app's reason to exist.
- **Editing (online-only)**: `<textarea>` with a rendered-preview toggle;
  Markdown via a small CommonMark renderer, Mermaid fences rendered on preview,
  autosave debounced (~2s idle). Saves go **straight to the API**; a failed
  write surfaces a "not saved — retrying" toast and retries, rather than a
  durable queue. Only the owner sees edit controls; recipients get a read view.
- **Tags (shared)**: tags are note content the owner edits; every participant
  sees them. The list filters client-side by tag chips. A "My notes" /
  "Shared with me" split gives each user their own organization without folders.
- **Sharing (read-only) + comments**: a share dialog takes an email →
  `GET /users/public-key` → wrap the note's CEK to that key → `POST
  /notes/{id}/share` (read-only). Recipients read the note and add **comments**
  (a note-level thread; any participant posts, encrypted under the note's CEK);
  the owner reads comments and edits the note. Participant list + unshare.
- **Search**: client-side over an **in-memory index of title + tags only**
  (decrypt each note's title/tags once per sync). Note **bodies are not indexed
  on web** — full-text search over bodies is a desktop/mobile feature. Keeps the
  web client light and avoids decrypting every body up front.
- **Password reset**: request email → open the link → paste the recovery key →
  set a new password; the client unwraps the envelope with the recovery key,
  re-wraps under the new password, and confirms.
- **Export / import**: download one or all notes as `.md`; import `.md` files as
  new owned notes (each gets a fresh CEK + owner grant).
- **Account deletion**: hard-confirmation dialog → `DELETE /auth/account`; drop
  all in-memory state.

## Online sync

- The web client holds the synced note/comment set **in memory** for the
  session; there is no IndexedDB cache and no offline write queue.
- Reads: on unlock it pages `GET /notes?since=` (keyset `next` cursor, cursor
  kept in memory only) to build the list, and `GET /notes/{id}` /
  `GET /notes/{id}/comments` on open. It re-syncs on `visibilitychange` and
  reconnect.
- Writes (create/edit/pin/share/comment) call the API directly. A transient
  failure retries with backoff behind a toast; a lost connection blocks the save
  (with feedback) rather than queueing — offline authoring is the desktop app's
  role.
- Owner edits use the client-generated id + `rev` compare-and-swap; a `409` (only
  possible against the owner's own other device) resolves keep-both.

## Rendering & client security

- Decrypted Markdown is untrusted at render time: rendered HTML is sanitized
  (DOMPurify) before insertion; Mermaid runs with `securityLevel: 'strict'`; a
  restrictive CSP (no inline script, no external origins except
  `api.memoza.io`) backstops both.
- `dek` and `privateKey` exist only as **non-extractable, in-memory
  `CryptoKey`s** — an XSS foothold can *use* them while the tab is open
  (unavoidable for any web E2EE app) but cannot exfiltrate the raw key, and
  nothing survives the tab closing. No plaintext, wrapped key, or note ciphertext
  is ever written to `localStorage`, `sessionStorage`, or IndexedDB.
- Dark mode via `prefers-color-scheme` + a manual toggle (CSS only).

## Decisions

- **No SPA framework** — vanilla TypeScript + Vite. The app competes on load
  time; a framework is the first thing a "simplicity and performance" product
  should not ship. Rejected: React/Svelte (bundle + dependency weight without
  payoff at this size).
- **Runtime dependencies limited to rendering**: `marked` (CommonMark),
  `DOMPurify`, `mermaid` (lazy-loaded only when a note contains a mermaid fence
  — by far the heaviest asset). Crypto, storage, routing, state, sync are all
  platform-native.
- **Online-only, memory-only web client** — keys, notes, and comments live only
  in memory; a refresh re-locks and re-prompts for the password. This is the
  simplest safe posture on a possibly-public machine and removes the entire
  offline-first stack (durable queue, IndexedDB cache, cursor persistence,
  cross-user conflict handling) from the web build. Rejected: persisting keys or
  ciphertext locally (leaves recoverable data on shared machines) and an
  offline-first web app (that resilience is the desktop/mobile shell's job).
- **Tags are shared note content, not per-user** — the owner tags a note and all
  participants see it; per-user organization is the client "My notes / Shared
  with me" split + tag filter. Rejected: folders and per-user tags (extra state
  and a shared-note placement problem for no gain over multi-tag filtering).
- **Read-only sharing + comments, not multi-writer** — recipients read and
  comment (a CEK-encrypted note-level thread) but cannot edit, so there is no
  cross-user conflict. Rejected: read-write sharing (keep-both forks over
  ciphertext with no server merge) and per-line comment anchoring (breaks as the
  owner edits — a hard problem for little v1 value).
- **Search over title + tags only** — decrypting every note body up front to
  index it janks and defeats the "light web client" goal; full-body search is a
  desktop feature. The index is in memory and rebuilt per sync (never persisted
  — it's plaintext).
- **Textarea editor in v1** — CodeMirror is a later upgrade; the storage format
  (Markdown text) doesn't change.
- **Client-generated ids + keyset `next` cursor** — the client mints note ids and
  drives the idempotent `PUT` create + paged sync described in the notes service;
  on web the cursor is kept only in memory for the session.
- **OS-keystore / biometric unlock is the desktop/mobile shell's feature** — it
  needs a secure keystore (Windows Hello / Keychain / Face ID); the `crypto`
  module's wrap/unwrap boundary is where the Tauri shell hooks in, so no web work
  now.

## Changes

- 2026-07-07 — Initial design.
- 2026-07-08 — Added keypair/CEK handling, sharing, folders/tags, password
  reset, export/import, account deletion, and the offline-first write queue.
- 2026-07-09 (review) — Repositioned as an **online-only, memory-only** client
  (offline-first + OS-keystore unlock moved to the Tauri desktop/mobile shell);
  dropped folders; tags are now shared note content; sharing is read-only with a
  comment thread; search covers title/tags only.
- 2026-07-10 (implemented) — Built `frontend/core` (crypto/api/store-interface/
  views, shared with the future desktop shell) and `frontend/web` (the
  in-memory `Store` impl + Vite entry) per `IMPLEMENTATION-PLAN.md` (now
  deleted; surviving decisions moved to `docs/architecture/frontend-core/
  README.md`). Notable implementation calls, detailed there: extractable keys
  are re-derived transiently from cached wrapped ciphertext for re-share/
  password-change instead of being held extractable at rest; the share dialog
  supports share/revoke by email but not a live participant list (no backend
  endpoint for that exists — see the notes service design); bulk export is one
  concatenated `.md` file (no zip dependency). CSP shipped via `public/
  _headers`; the password-reset email link is hash-routed
  (`/#/reset?token=&email=`) to match the client's hash router.
