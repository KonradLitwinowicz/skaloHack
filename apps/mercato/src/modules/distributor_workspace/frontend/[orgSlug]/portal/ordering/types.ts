export type PortalCatalogItem = {
  productId: string
  sku: string | null
  title: string
  categoryCode: string | null
}

export type PortalCatalogCategory = {
  code: string
  label: string
  productCount: number
}

export type PortalCatalogResponse = {
  ok: boolean
  items: PortalCatalogItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  categories: PortalCatalogCategory[]
}

/** Mirrors the server allow-list in `lib/portalPricing.ts`. No cost, markup or margin exists here. */
export type PortalQuoteLine = {
  productId: string
  sku: string | null
  quantity: string
  unitPriceNet: string
  totalPriceNet: string
}

export type PortalQuoteResponse = {
  ok: boolean
  currencyCode: string
  lines: PortalQuoteLine[]
  totalNet: string
}

export type PortalSubmitResponse = {
  ok: boolean
  kind: 'quote' | 'order'
  documentId: string
}

export type BasketEntry = {
  productId: string
  sku: string | null
  title: string
  quantity: number
}

export type SubmitKind = 'quote' | 'order'

export function formatMoney(value: string, currencyCode: string, locale: string): string {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return value
  if (!currencyCode) return amount.toFixed(2)
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency: currencyCode,
    }).format(amount)
  } catch {
    // An unexpected currency code must not blank out the price the customer is about to accept.
    return `${amount.toFixed(2)} ${currencyCode}`
  }
}
