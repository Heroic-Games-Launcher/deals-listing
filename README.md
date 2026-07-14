# deals-listing

Generates the game-deal feeds shown on Heroic's Discounts screen.

Scheduled GitHub Actions pull each store's discounted catalog from the
[impact.com](https://impact.com) partner API, normalize it, and force-push a
static JSON per currency to a dedicated orphan branch. The Heroic app reads
those branches at runtime — no impact.com credentials ever ship in the app.

| Store | Workflow | Branch | Files |
|-------|----------|--------|-------|
| Green Man Gaming | `.github/workflows/gmg-feed.yml` | `gmg-feed` | `gmg-discounts-<CURRENCY>.json` |
| Humble Bundle | `.github/workflows/humble-feed.yml` | `humble-feed` | `humble-discounts-<CURRENCY>.json` |

## Required repository secrets

- `IMPACT_ACCOUNT_SID`
- `IMPACT_AUTH_TOKEN`

## Optional repository variables

- `IMPACT_CATALOG_ID` — pin the GMG mirror to a single catalog
- `HUMBLE_CATALOG_ID` — pin the Humble mirror to a single catalog

Run a workflow manually from the Actions tab (`workflow_dispatch`) to publish
the first feed.
