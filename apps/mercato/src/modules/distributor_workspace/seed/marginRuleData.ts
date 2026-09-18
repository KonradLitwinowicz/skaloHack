/**
 * Demo margin policy for the seeded HoReCa distributor.
 *
 * These are business inputs, not code: they exist so the rule screens and the margin panel have a
 * realistic, non-uniform policy to display and edit. Every row is written as `is_demo` and the real
 * policy replaces it through the rules screen.
 *
 * Markup, not margin, is what the engine's `target_margin` component reads today
 * (`lib/components/targetMargin.ts` → `payload.targetMarkupPercent`). The conversion is
 * `markup = margin / (1 - margin)`, and both figures are shown side by side wherever a human reads them.
 */

export type MarginRuleSeed = {
  /** Which category the rule applies to; matches `pricing_purchase_positions.product_group_code`. */
  productGroupCode: string
  targetMarkupPercent: string
  rationale: string
}

export type CustomerGroupMarginRuleSeed = {
  /** Matches `pricing_customer_profiles.customer_group_code`, which the seeder sets to the segment. */
  customerGroupCode: string
  targetMarkupPercent: string
  rationale: string
}

export type CustomerMarginRuleSeed = {
  /** The customer's stable seed handle; resolved to a customer id at seed time. */
  customerHandle: string
  targetMarkupPercent: string
  rationale: string
}

/**
 * Chemicals carry service and handling risk and hold the highest markup; paper is a commodity a
 * customer can price-check anywhere, so it runs thin; packaging sits between the two.
 */
export const PRODUCT_GROUP_MARGIN_RULES: MarginRuleSeed[] = [
  { productGroupCode: 'horeca-chemia-myjaca-do-naczyn', targetMarkupPercent: '72.0000', rationale: 'Wysoka rotacja, doradztwo techniczne przy dozowaniu' },
  { productGroupCode: 'horeca-chemia-do-zmywarek', targetMarkupPercent: '78.0000', rationale: 'Sprzedaz wiazana z serwisem zmywarek' },
  { productGroupCode: 'horeca-srodki-dezynfekcyjne', targetMarkupPercent: '84.0000', rationale: 'Wymogi sanitarne, niska wrazliwosc cenowa' },
  { productGroupCode: 'horeca-chemia-do-powierzchni-i-sanitariatow', targetMarkupPercent: '69.0000', rationale: 'Standardowy asortyment utrzymania czystosci' },
  { productGroupCode: 'horeca-srodki-do-podlog', targetMarkupPercent: '66.0000', rationale: 'Baza porownawcza — poziom domyslny dostawcy' },
  { productGroupCode: 'horeca-opakowania-na-wynos', targetMarkupPercent: '58.0000', rationale: 'Silna konkurencja, klient porownuje ceny' },
  { productGroupCode: 'horeca-pojemniki-i-tacki', targetMarkupPercent: '54.0000', rationale: 'Towar masowy, decyduje cena za sztuke' },
  { productGroupCode: 'horeca-sztucce-i-naczynia-jednorazowe', targetMarkupPercent: '61.0000', rationale: 'Zroznicowany asortyment, czesc pozycji niszowa' },
  { productGroupCode: 'horeca-folie-i-worki', targetMarkupPercent: '49.0000', rationale: 'Commodity, cena za kilogram surowca' },
  { productGroupCode: 'horeca-reczniki-papierowe', targetMarkupPercent: '44.0000', rationale: 'Towar porownywalny, klient zna ceny rynkowe' },
  { productGroupCode: 'horeca-papier-toaletowy', targetMarkupPercent: '41.0000', rationale: 'Najnizszy narzut — czysty commodity' },
  { productGroupCode: 'horeca-serwetki-i-obrusy', targetMarkupPercent: '63.0000', rationale: 'Element prezentacji stolu, wieksza tolerancja cenowa' },
  { productGroupCode: 'horeca-chemia-do-prania', targetMarkupPercent: '64.0000', rationale: 'Pralnie hotelowe, sprzedaz w duzych opakowaniach' },
  { productGroupCode: 'horeca-chemia-kuchenna-specjalistyczna', targetMarkupPercent: '88.0000', rationale: 'Preparaty niszowe, brak porownania rynkowego' },
  { productGroupCode: 'horeca-czysciwa-i-sciereczki', targetMarkupPercent: '59.0000', rationale: 'Materialy eksploatacyjne o stalym zuzyciu' },
  { productGroupCode: 'horeca-dozowniki-i-akcesoria-papiernicze', targetMarkupPercent: '92.0000', rationale: 'Sprzet wiazacy klienta z wkladami — narzut na urzadzeniu' },
  { productGroupCode: 'horeca-kosmetyki-i-higiena-rak', targetMarkupPercent: '76.0000', rationale: 'Wymogi sanitarne, zakup powtarzalny' },
  { productGroupCode: 'horeca-kubki-i-wieczka', targetMarkupPercent: '52.0000', rationale: 'Towar masowy, klient porownuje cene za sztuke' },
  { productGroupCode: 'horeca-opakowania-do-pizzy-i-cateringu', targetMarkupPercent: '56.0000', rationale: 'Sezonowa rotacja, konkurencja lokalna' },
]

/**
 * Segment rules override the product-group rule: a hospital tenders and squeezes, a café does not.
 * Scope precedence is customer → customer_group → product → product_group → global
 * (`lib/params.ts` SCOPE_PRECEDENCE), so these sit above the group rules above.
 */
export const CUSTOMER_GROUP_MARGIN_RULES: CustomerGroupMarginRuleSeed[] = [
  { customerGroupCode: 'szpital', targetMarkupPercent: '38.0000', rationale: 'Zamowienia przetargowe, duzy wolumen, presja cenowa' },
  { customerGroupCode: 'szkola', targetMarkupPercent: '42.0000', rationale: 'Budzet publiczny, postepowania cenowe' },
  { customerGroupCode: 'hotel', targetMarkupPercent: '55.0000', rationale: 'Staly kontrakt, przewidywalny wolumen' },
  { customerGroupCode: 'kawiarnia', targetMarkupPercent: '74.0000', rationale: 'Male koszyki, wysoki koszt obslugi na zamowienie' },
  { customerGroupCode: 'piekarnia', targetMarkupPercent: '68.0000', rationale: 'Zamowienia regularne, sredni koszyk' },
]

/** Individually negotiated customers — the sharpest override, and the one an operator edits most. */
export const CUSTOMER_MARGIN_RULES: CustomerMarginRuleSeed[] = [
  { customerHandle: 'horeca-szpital-wolski', targetMarkupPercent: '32.0000', rationale: 'Kontrakt roczny wynegocjowany centralnie' },
  { customerHandle: 'horeca-hotel-wilanow-park', targetMarkupPercent: '48.0000', rationale: 'Klient strategiczny, rabat lojalnosciowy' },
]

/**
 * Guardrails are a floor, not a target: whatever the rules above produce, the price may not leave a
 * margin below this. `min_margin_percent` is a MARGIN (on price), unlike the markup targets above —
 * that asymmetry is deliberate and is what a floor must protect.
 */
export type GuardrailSeed = {
  code: string
  scope: 'global' | 'customer_group'
  scopeRefId: string | null
  minMarginPercent: string
  maxDiscountPercent: string
  rationale: string
}

export const GUARDRAIL_RULES: GuardrailSeed[] = [
  { code: 'floor-global', scope: 'global', scopeRefId: null, minMarginPercent: '12.0000', maxDiscountPercent: '25.0000', rationale: 'Minimum dla calego asortymentu' },
  { code: 'floor-szpital', scope: 'customer_group', scopeRefId: 'szpital', minMarginPercent: '8.0000', maxDiscountPercent: '35.0000', rationale: 'Przetargi dopuszczaja nizszy prog' },
  { code: 'floor-kawiarnia', scope: 'customer_group', scopeRefId: 'kawiarnia', minMarginPercent: '18.0000', maxDiscountPercent: '15.0000', rationale: 'Male koszyki nie moga schodzic nisko' },
]
