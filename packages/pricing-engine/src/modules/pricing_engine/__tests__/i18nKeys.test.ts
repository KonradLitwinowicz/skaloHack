import de from '../i18n/de.json'
import en from '../i18n/en.json'
import es from '../i18n/es.json'
import ko from '../i18n/ko.json'
import pl from '../i18n/pl.json'
import { implementedComponents, PIPELINE_COMPONENT_CODES } from '../lib/components'
import { runPipeline } from '../lib/pipeline'
import { buildContext, buildDeps, PRODUCT_ID } from './fixtures'

const enKeys = new Set(Object.keys(en as Record<string, string>))
const plKeys = new Set(Object.keys(pl as Record<string, string>))

// Every scenario below is chosen to drive a DIFFERENT branch, so the sweep reaches the
// missing-data explain keys and warnings that a happy-path run never emits.
const SCENARIOS: Array<{ name: string; run: () => ReturnType<typeof runPipeline> }> = [
  {
    name: 'happy path',
    run: () =>
      runPipeline(
        buildContext({ orderScenarioCode: 'ideal_file', deliveryZoneCode: 'warszawa_poludnie' }),
        implementedComponents,
        buildDeps(),
      ),
  },
  {
    name: 'no purchase position',
    run: () =>
      runPipeline(buildContext(), implementedComponents, buildDeps({ product: { purchase: null } })),
  },
  {
    name: 'no delivery zone, no scenario',
    run: () =>
      runPipeline(
        buildContext({ orderScenarioCode: null, deliveryZoneCode: null }),
        implementedComponents,
        buildDeps(),
      ),
  },
  {
    name: 'no physical attributes',
    run: () =>
      runPipeline(
        buildContext({ deliveryZoneCode: 'mazowieckie_daleko' }),
        implementedComponents,
        buildDeps({ product: { weightValue: null, dimensions: null } }),
      ),
  },
  {
    name: 'negotiated price wins',
    run: () =>
      runPipeline(
        buildContext(),
        implementedComponents,
        buildDeps({ lookup: { negotiatedPrices: { [PRODUCT_ID]: '9.0000' } } }),
      ),
  },
]

describe('i18n key coverage', () => {
  // A component that emits a key no locale carries renders a raw dotted identifier to the sales
  // rep instead of an explanation. That is invisible in every other test, so it is guarded here.
  it.each(SCENARIOS)('resolves every key emitted on the "$name" path', async ({ run }) => {
    const result = await run()
    const emitted = new Set<string>()
    for (const line of result.lines) {
      for (const warning of line.warnings) emitted.add(warning)
      for (const component of line.breakdown) {
        emitted.add(component.labelKey)
        emitted.add(component.explainKey)
        for (const warning of component.warnings ?? []) emitted.add(warning)
      }
    }
    expect(emitted.size).toBeGreaterThan(0)
    const missingEn = [...emitted].filter((key) => !enKeys.has(key)).sort()
    const missingPl = [...emitted].filter((key) => !plKeys.has(key)).sort()
    expect(missingEn).toEqual([])
    expect(missingPl).toEqual([])
  })

  it('carries a label for every component in the declared pipeline, implemented or not', () => {
    // The coverage screen lists all eleven codes, so all eleven need a label — otherwise the
    // pending rows render as dotted identifiers.
    const missing = PIPELINE_COMPONENT_CODES.map((code) => {
      const camel = code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
      return `pricing_engine.components.${camel}.label`
    }).filter((key) => !enKeys.has(key))
    expect(missing).toEqual([])
  })

  // Every shipped locale, not just Polish. `yarn i18n:check-sync` is a CI gate over all five, and a
  // test that names all of them while checking one is worse than no test: it reports safety it does
  // not provide, which is exactly how two keys once shipped to en and pl alone.
  it.each([
    ['pl', pl],
    ['de', de],
    ['es', es],
    ['ko', ko],
  ])('keeps %s at exact key parity with English', (_locale, dictionary) => {
    expect(Object.keys(dictionary as Record<string, string>).sort()).toEqual([...enKeys].sort())
  })

  // Every scenario, not only the happy path: the branches that matter most here are precisely the
  // ones a happy-path run never reaches, and those explain templates carry the most placeholders.
  it.each(SCENARIOS)('never ships an unsupplied placeholder on the "$name" path', async ({ run }) => {
    const result = await run()
    for (const line of result.lines) {
      for (const component of line.breakdown) {
        const template = (en as Record<string, string>)[component.explainKey]
        const placeholders = [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
        const unsupplied = placeholders.filter((name) => component.explainValues[name] === undefined)
        expect({ key: component.explainKey, unsupplied }).toEqual({
          key: component.explainKey,
          unsupplied: [],
        })
      }
    }
  })
})
