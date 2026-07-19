# Data Model — `memoza_subscriptions` (D1) — Planned

One database, owned exclusively by `memoza-billing`. Nothing implemented yet.

## `subscription`

One row per user (a user has at most one Memoza subscription, whichever store
it came from).

| Column | Type | Notes |
|---|---|---|
| `user_id` | TEXT PK | From the trusted gateway header on `/billing/verify` |
| `platform` | TEXT NOT NULL | `apple` or `google` |
| `product_id` | TEXT NOT NULL | Store product/SKU (e.g. monthly vs yearly) |
| `store_ref` | TEXT UNIQUE NOT NULL | Apple `original_transaction_id` / Google `purchase_token` — how store notifications find this row without a user id |
| `status` | TEXT NOT NULL | `active`, `grace`, `canceled` (active until expiry, won't renew), `expired`, `refunded` |
| `expires_at` | INTEGER NOT NULL | Unix ms; entitlement = `status in (active, grace, canceled) AND expires_at > now` |
| `updated_at` | INTEGER NOT NULL | Unix ms of the last verify/notification write |

Index: `idx_subscription_ref` on `(store_ref)` — notification lookup.
