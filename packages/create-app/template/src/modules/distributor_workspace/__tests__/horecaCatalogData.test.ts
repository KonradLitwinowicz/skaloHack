import {
  HORECA_CATEGORIES,
  HORECA_PRODUCTS,
  type HorecaCategorySeed,
} from '../seed/horecaCatalogData'

/**
 * The pricing engine reads these numbers directly: `product_cost` divides by the tier discount,
 * `warehouse_cost` divides by pallet geometry derived from the dimensions, `packaging_cost`
 * multiplies by the unit conversions, and `product_aspects` reads weight. A zero or an absurd
 * value here does not fail loudly — it quietly produces a wrong price. Hence these assertions.
 */

const DECIMAL_STRING = /^\d+(\.\d+)?$/

function leafSlugs(nodes: readonly HorecaCategorySeed[]): string[] {
  return nodes.flatMap((node) =>
    node.children && node.children.length ? leafSlugs(node.children) : [node.slug],
  )
}

function allSlugs(nodes: readonly HorecaCategorySeed[]): string[] {
  return nodes.flatMap((node) => [node.slug, ...allSlugs(node.children ?? [])])
}

const LEAVES = new Set(leafSlugs(HORECA_CATEGORIES))

describe('HoReCa catalog seed data', () => {
  it('ships 200 products', () => {
    expect(HORECA_PRODUCTS).toHaveLength(200)
  })

  it('offers at least 12 leaf categories', () => {
    expect(LEAVES.size).toBeGreaterThanOrEqual(12)
  })

  it('has unique category slugs across the whole tree', () => {
    const slugs = allSlugs(HORECA_CATEGORIES)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('has unique product handles and SKUs, variants included', () => {
    const handles = HORECA_PRODUCTS.map((product) => product.handle)
    const skus = [
      ...HORECA_PRODUCTS.map((product) => product.sku),
      ...HORECA_PRODUCTS.flatMap((product) => (product.variants ?? []).map((variant) => variant.sku)),
    ]
    expect(new Set(handles).size).toBe(handles.length)
    expect(new Set(skus).size).toBe(skus.length)
  })

  it('namespaces every handle so the four pre-existing core demo products are never touched', () => {
    const unprefixed = HORECA_PRODUCTS.filter((product) => !product.handle.startsWith('horeca-'))
    expect(unprefixed.map((product) => product.handle)).toEqual([])
  })

  it('assigns every product to a category that exists as a leaf', () => {
    const dangling = HORECA_PRODUCTS.filter((product) => !LEAVES.has(product.categorySlug))
    expect(dangling.map((product) => `${product.handle}:${product.categorySlug}`)).toEqual([])
  })

  it('never prices a product below its purchase cost', () => {
    const losing = HORECA_PRODUCTS.filter(
      (product) => Number(product.purchaseCostNet) >= Number(product.priceNet),
    )
    expect(losing.map((product) => `${product.handle}:${product.purchaseCostNet}>=${product.priceNet}`)).toEqual([])
  })

  it('spreads markup instead of repeating the seeded 66% default everywhere', () => {
    const markups = HORECA_PRODUCTS.map(
      (product) => (Number(product.priceNet) - Number(product.purchaseCostNet)) / Number(product.purchaseCostNet),
    )
    const min = Math.min(...markups)
    const max = Math.max(...markups)
    expect(min).toBeGreaterThan(0.1)
    expect(max).toBeLessThan(3)
    expect(max - min).toBeGreaterThan(0.3)
  })

  it('carries a positive weight and three positive dimensions for every product', () => {
    const broken = HORECA_PRODUCTS.filter((product) => {
      const weight = Number(product.weightKg)
      const { length, width, height } = product.dimensionsCm
      return (
        !Number.isFinite(weight) ||
        weight <= 0 ||
        Number(length) <= 0 ||
        Number(width) <= 0 ||
        Number(height) <= 0
      )
    })
    expect(broken.map((product) => product.handle)).toEqual([])
  })

  it('gives every product a usable packaging ladder', () => {
    // A factor of exactly 1 is legitimate: when the base unit is already a bundle (a 50-box
    // pack of pizza cartons), one shipping carton holds exactly one of them. What must never
    // happen is a factor below 1, or a ladder with no step that actually aggregates — the
    // packaging component multiplies by these, so a flat ladder silently prices nothing.
    const broken = HORECA_PRODUCTS.filter((product) => {
      if (!product.unitConversions.length) return true
      const factors = product.unitConversions.map((conversion) => Number(conversion.toBaseFactor))
      if (factors.some((factor) => !Number.isFinite(factor) || factor < 1)) return true
      return !factors.some((factor) => factor > 1)
    })
    expect(broken.map((product) => product.handle)).toEqual([])
  })

  it('keeps unit codes distinct within a product ladder', () => {
    const duplicated = HORECA_PRODUCTS.filter((product) => {
      const codes = product.unitConversions.map((conversion) => conversion.unitCode)
      return new Set(codes).size !== codes.length
    })
    expect(duplicated.map((product) => product.handle)).toEqual([])
  })

  it('emits every money, weight and factor value as a decimal string', () => {
    const offenders = HORECA_PRODUCTS.flatMap((product) => {
      const fields: Array<[string, unknown]> = [
        ['priceNet', product.priceNet],
        ['purchaseCostNet', product.purchaseCostNet],
        ['tierDiscountPercent', product.tierDiscountPercent],
        ['annualVolume', product.annualVolume],
        ['weightKg', product.weightKg],
      ]
      return fields
        .filter(([, value]) => typeof value !== 'string' || !DECIMAL_STRING.test(value as string))
        .map(([name]) => `${product.handle}:${name}`)
    })
    expect(offenders).toEqual([])
  })

  it('keeps tier discounts inside a believable rebate range', () => {
    const outOfRange = HORECA_PRODUCTS.filter((product) => {
      const discount = Number(product.tierDiscountPercent)
      return !Number.isFinite(discount) || discount < 0 || discount > 20
    })
    expect(outOfRange.map((product) => product.handle)).toEqual([])
  })

  it('prices every variant consistently with its parent rather than at zero', () => {
    const broken = HORECA_PRODUCTS.flatMap((product) =>
      (product.variants ?? [])
        .filter((variant) => !(Number(variant.priceNet) > 0) || !(Number(variant.weightKg) > 0))
        .map((variant) => `${product.handle}:${variant.sku}`),
    )
    expect(broken).toEqual([])
  })

  it('ships a meaningful number of configurable products and a few hazardous ones', () => {
    const withVariants = HORECA_PRODUCTS.filter((product) => (product.variants ?? []).length > 0)
    const hazmat = HORECA_PRODUCTS.filter((product) => product.hazmat === true)
    expect(withVariants.length).toBeGreaterThanOrEqual(20)
    expect(hazmat.length).toBeGreaterThanOrEqual(4)
  })
})
