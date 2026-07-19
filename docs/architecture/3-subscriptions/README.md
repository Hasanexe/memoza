# Subscriptions Service — `memoza-billing` (Planned)

Paid subscription support for Memoza, purchased **in-app on iOS and Android**
via the platforms' own billing systems (Apple App Store / Google Play — both
stores require in-app purchases to go through them). Web checkout is out of
scope for now (future option: Stripe/Paddle; noted, not designed). Status:
**Planned — nothing implemented**; build plan in
`backend-services/3-subscriptions/IMPLEMENTATION-PLAN.md`. Data model:
`table.md`.

## Trust model

The client's claim of "I'm subscribed" is never trusted. The mobile app
completes the purchase with the store, then hands the store's proof to
`memoza-billing`, which verifies it **server-to-server** with Apple/Google and
records the entitlement. Store lifecycle events (renewal, cancellation,
refund, grace period) arrive via each store's server notifications, so the
recorded state stays correct even when the app never reopens. Note content
remains E2EE and unrelated to billing — this service never touches notes or
keys.

## Component view

Single Cloudflare Worker `memoza-billing`, D1 database `memoza_subscriptions`.
Authenticated endpoints are reached through `memoza-gateway` (JWT →
`X-User-Id`, same pattern as `memoza-notes`); the two store-notification
endpoints are public routes authenticated **cryptographically** (Apple: JWS
signature on the notification; Google: OIDC token on the Pub/Sub push) rather
than by user identity — a store, not a user, is the caller.

## Endpoint map (planned)

| Endpoint | Purpose |
|---|---|
| `POST /billing/verify` | Authenticated. `{platform: "apple"\|"google", proof}` — Apple: the StoreKit 2 signed transaction (JWS); Google: `{purchase_token, product_id}`. Worker verifies with the store's server API, upserts the `subscription` row for `X-User-Id`, returns the status |
| `GET /billing/status` | Authenticated. `{plan, status, expires_at, platform}` for the caller — drives the app's UI. Clients re-check on launch/refocus |
| `POST /billing/notifications/apple` | Public route. App Store Server Notifications V2 — JWS verified against Apple's certificate chain; updates the matching subscription by `original_transaction_id` |
| `POST /billing/notifications/google` | Public route. Google Real-Time Developer Notifications (Pub/Sub push) — OIDC token verified; updates the matching subscription by `purchase_token` |

## Decisions (initial — refine before building)

- **Separate service, own database** — billing state has its own lifecycle,
  its own external callers (the stores), and secrets no other service should
  hold. Rejected: folding into `memoza-auth` (mixes store-API secrets into the
  most sensitive worker).
- **Server-side verification + store notifications, not client claims** — the
  only correct model; a patched client can fake anything else.
- **Entitlement enforcement is deferred** — *what premium actually unlocks is
  an open product decision* (candidates: note/storage caps, publish limits,
  device count). Until a server-enforced premium feature exists, the
  subscription state only drives client UI via `/billing/status`; no JWT
  claim, no gateway header. Revisit (JWT `plan` claim with its ≤15-min lag is
  the likely shape) once the first gated feature is chosen.
- **Web checkout deferred** — mobile IAP first (it's mandatory there anyway);
  a web PSP adds a second, very different integration for later.
- **Account deletion** — `DELETE /auth/account` must also clear this service's
  rows (same internal-purge pattern as notes); store subscriptions themselves
  are cancelled by the user through the store, not by us (we can't cancel on
  their behalf — document in the deletion UI).

## Changes

- 2026-07-16 — Initial planned design: mobile-IAP subscriptions
  (Apple/Google), server-verified with store notifications; entitlement gates
  deliberately left open until premium features are defined.
