// Mirrors Humble Bundle's per-currency Impact catalogs into
// <output-dir>/humble-discounts-<CURRENCY>.json, keeping only discounted items.
//
// Env: IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN (required),
//      IMPACT_CATALOG_ID (optional, mirror only this catalog)
// Usage: node .github/scripts/mirror-humble-feed.mjs <output-dir>

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const API_BASE = process.env.IMPACT_API_BASE ?? 'https://api.impact.com'
const PAGE_SIZE = 1000
const MAX_PAGES = 20

// Never add `Uri` here: it embeds the partner Account SID in its path.
const KEPT_FIELDS = [
  'CatalogItemId',
  'Id',
  'Name',
  'Url',
  'ImageUrl',
  'CurrentPrice',
  'OriginalPrice',
  'Currency',
  'Text1'
]

const requireEnv = (name) => {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required env var ${name}`)
    process.exit(1)
  }
  return value
}

const outDir = process.argv[2]
if (!outDir) {
  console.error('Usage: node mirror-humble-feed.mjs <output-dir>')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const accountSid = requireEnv('IMPACT_ACCOUNT_SID')
const authToken = requireEnv('IMPACT_AUTH_TOKEN')

const headers = {
  Authorization:
    'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
  Accept: 'application/json',
  'IR-Version': '16'
}

const get = async (path) => {
  const res = await fetch(`${API_BASE}${path}`, { headers })
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

// UAT catalogs are Impact staging feeds: they may expose base prices only.
const isUatCatalog = (catalog) =>
  /\buat\b/i.test(`${catalog.CampaignName ?? ''} ${catalog.Name ?? ''}`)

// Per currency, keep the catalog with the most items (Humble may also publish
// tiny curated catalogs in the same currencies).
const findCatalogs = async () => {
  const data = await get(`/Mediapartners/${accountSid}/Catalogs`)
  const catalogs = (data.Catalogs ?? []).filter((c) =>
    /humble/i.test(`${c.CampaignName ?? ''} ${c.Name ?? ''}`)
  )

  // If a production catalog appears next to a UAT one, never prefer the UAT one.
  const production = catalogs.filter((c) => !isUatCatalog(c))
  const candidates = production.length ? production : catalogs
  if (!production.length && catalogs.length) {
    console.warn(
      'Only UAT Humble catalog(s) visible; sale prices may be missing (Impact staging feed).'
    )
  }

  const fromEnv = process.env.IMPACT_CATALOG_ID
  if (fromEnv) {
    const match = catalogs.find((c) => c.Id === fromEnv)
    if (!match) {
      console.error(`Catalog ${fromEnv} not found among Humble catalogs`)
      process.exit(1)
    }
    return [match]
  }

  const byCurrency = new Map()
  for (const c of candidates) {
    const currency = (c.Currency ?? '').toUpperCase()
    if (!currency) continue
    const best = byCurrency.get(currency)
    if (!best || Number(c.NumberOfItems) > Number(best.NumberOfItems)) {
      byCurrency.set(currency, c)
    }
  }

  if (byCurrency.size === 0) {
    console.error(
      'Could not auto-discover Humble catalogs. Catalogs visible to this account:'
    )
    for (const c of data.Catalogs ?? []) {
      console.error(
        `  Id=${c.Id} CampaignName=${c.CampaignName} Currency=${c.Currency}`
      )
    }
    process.exit(1)
  }
  return [...byCurrency.values()]
}

const fetchAllItems = async (catalogId) => {
  const items = []
  let page = 1
  let numPages = 1
  do {
    const data = await get(
      `/Mediapartners/${accountSid}/Catalogs/${catalogId}/Items?PageSize=${PAGE_SIZE}&Page=${page}`
    )
    const pageItems = data.Items ?? []

    // A feed with no OriginalPrice anywhere is an upstream base-price-only feed
    // (Impact UAT catalog). There is nothing to mirror: skip without failing and
    // keep the previous good feed untouched.
    if (page === 1 && !pageItems.some((item) => Number(item.OriginalPrice) > 0)) {
      console.warn(
        `Catalog ${catalogId} has no OriginalPrice/sale data (upstream base-price-only feed); skipping.`
      )
      return { items: [], hasSalePrices: false, basePriceOnly: true, sampleItems: pageItems }
    }

    items.push(...pageItems)
    numPages = Math.min(parseInt(data['@numpages'] ?? '1', 10) || 1, MAX_PAGES)
    console.log(
      `Fetched page ${page}/${numPages} (${items.length} items so far)`
    )
    page++
  } while (page <= numPages)
  return { items, hasSalePrices: true, basePriceOnly: false, sampleItems: [] }
}

const CHOICE_PAGE = 'https://www.humblebundle.com/membership'
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

// Builds a single Humble Choice card for the feed: current membership price vs the
// retail value of the games included. The app only shows items whose base price is
// above the current one, so the card uses the bundle's retail value as base.
const fetchChoiceCard = async (sampleItems) => {
  try {
    const res = await fetch(CHOICE_PAGE, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()

    const meta = html.match(
      /Get\s+([A-Z][a-z]+)\s+(\d{4})\s+Humble Choice[^"]*?just\s+\$([\d.]+)\s+per month/i
    )
    const price = meta ? Number(meta[3]) : null
    const month = meta ? meta[1] : MONTHS[new Date().getUTCMonth()]
    const year = meta ? meta[2] : String(new Date().getUTCFullYear())

    // subscriptionProducts carries the retail price of each included game.
    const productRe =
      /\\"title\\":\\"([^"\\]+)\\",\\"description\\":\\"[^"\\]*\\",\\"url\\":\\"[^"\\]*\\",\\"displayPrice\\":\{[^{}]*\\"currentPrice\\":\{[^{}]*\\"centAmount\\":([0-9.]+)/g
    let retail = 0
    let games = 0
    let match
    while ((match = productRe.exec(html)) !== null) {
      const title = match[1]
      if (/ign plus|subscription/i.test(title)) continue
      retail += Number(match[2]) / 100
      games++
    }
    if (!price || !Number.isFinite(retail) || retail <= price) return null

    const image =
      html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ??
      null

    const tracking = (sampleItems ?? [])
      .map((item) => String(item.Url ?? ''))
      .find((url) => /\/c\/\d+\/\d+\/\d+/.test(url))
    let url = CHOICE_PAGE
    if (tracking) {
      const parts = tracking.match(/^(https:\/\/[^/]+)\/c\/(\d+)\/(\d+)\/(\d+)/)
      if (parts) {
        url =
          `${parts[1]}/c/${parts[2]}/${parts[3]}/${parts[4]}` +
          `?u=${encodeURIComponent(CHOICE_PAGE)}&subId1=choice`
      }
    }

    return {
      CatalogItemId: 'humble_choice',
      Id: 'product_humble_choice',
      Name: `Humble Choice — ${month} ${year}`,
      Url: url,
      ImageUrl: image,
      CurrentPrice: price.toFixed(2),
      OriginalPrice: retail.toFixed(2),
      Currency: 'USD',
      Text1: ''
    }
  } catch (err) {
    console.warn(`Could not build the Humble Choice card: ${err.message}`)
    return null
  }
}

const catalogs = await findCatalogs()
console.log(
  `Mirroring ${catalogs.length} Humble catalog(s): ` +
    catalogs.map((c) => `${c.Currency}=${c.Id}`).join(', ')
)

let published = 0

for (const catalog of catalogs) {
  const currency = (catalog.Currency ?? '').toUpperCase()
  const { items, hasSalePrices, basePriceOnly, sampleItems } = await fetchAllItems(catalog.Id)
  if (!hasSalePrices) {
    if (basePriceOnly) {
      // The feed is up but carries base prices only: the previous mirror is stale
      // (sales ended / Impact is serving the UAT catalog). Publish a single Humble
      // Choice card so the app still offers the bundle, without expired discounts.
      const choiceCard = await fetchChoiceCard(sampleItems)
      const feedItems = choiceCard ? [choiceCard] : []
      const outFile = join(outDir, `humble-discounts-${currency}.json`)
      writeFileSync(outFile, JSON.stringify({ '@page': '1', '@numpages': '1', Items: feedItems }))
      if (choiceCard) {
        console.log(
          `::warning::Humble Impact feed has no sale prices; publishing the Humble Choice card only (${choiceCard.Name}, ${choiceCard.CurrentPrice} ${currency} vs ${choiceCard.OriginalPrice} retail).`
        )
        console.log(`Wrote Humble Choice card to ${outFile}.`)
      } else {
        console.log(
          '::warning::Humble Impact feed has no sale prices and the Humble Choice card could not be built; publishing an empty feed to clear stale discounts.'
        )
        console.warn(`Wrote empty ${currency} feed to ${outFile}.`)
      }
      published++
    }
    continue
  }

  const discounted = items
    .filter((item) => {
      const current = parseFloat(item.CurrentPrice ?? '')
      const original = parseFloat(item.OriginalPrice ?? '')
      return (
        Number.isFinite(current) &&
        Number.isFinite(original) &&
        current >= 0 &&
        original > current
      )
    })
    .map((item) =>
      Object.fromEntries(
        KEPT_FIELDS.filter((f) => item[f] !== undefined).map((f) => [
          f,
          item[f]
        ])
      )
    )

  // Zero discounted items means the feed or the parsing broke; fail instead
  // of overwriting the last good mirror.
  if (discounted.length === 0) {
    console.error(
      `Refusing to publish ${currency}: 0 discounted items of ${items.length}`
    )
    process.exit(1)
  }

  const outFile = join(outDir, `humble-discounts-${currency}.json`)
  writeFileSync(
    outFile,
    JSON.stringify({ '@page': '1', '@numpages': '1', Items: discounted })
  )
  console.log(
    `Wrote ${discounted.length} discounted items (of ${items.length}) to ${outFile}`
  )
  published++
}

if (published === 0) {
  console.warn(
    'No Humble catalog published this run (upstream feed has no sale prices). Keeping the last good mirror.'
  )
}
