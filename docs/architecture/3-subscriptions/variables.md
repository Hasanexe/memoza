# Variables & Secrets — `memoza-billing` (Planned)

Names only, never values. Nothing implemented yet.

## Vars (`billing-worker/wrangler.jsonc`)

| Var | Purpose |
|---|---|
| `APPLE_BUNDLE_ID` | iOS app bundle id (verify notifications/transactions belong to us) |
| `APPLE_ENVIRONMENT` | `Sandbox` or `Production` App Store Server API host |
| `GOOGLE_PACKAGE_NAME` | Android application id |
| `PRODUCT_IDS` | Comma-separated accepted subscription product ids |

## Secrets

| Secret | Purpose |
|---|---|
| `APPLE_IAP_PRIVATE_KEY` | ES256 key signing App Store Server API request JWTs |
| `APPLE_KEY_ID` | Key id for the above |
| `APPLE_ISSUER_ID` | App Store Connect issuer id |
| `GOOGLE_SA_EMAIL` | Google service-account email (Play Developer API) |
| `GOOGLE_SA_PRIVATE_KEY` | RS256 key for the service-account token exchange |
