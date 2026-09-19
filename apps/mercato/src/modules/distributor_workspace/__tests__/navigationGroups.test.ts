import fs from 'node:fs'
import path from 'node:path'
import {
  distributorNavGroupOrder,
  distributorNavGroups,
  distributorNavHiddenPages,
  distributorNavPageOverrides,
  enabledModules,
} from '@/modules'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')
const GENERATED_BACKEND_ROUTES = path.resolve(APP_ROOT, '..', '.mercato', 'generated', 'backend-routes.generated.ts')

/**
 * The registry is read as text rather than imported: importing it pulls in every page module in the
 * app, and the only fact under test is which paths the generator emitted.
 */
function readGeneratedBackendRoutePaths(): Set<string> {
  const source = fs.readFileSync(GENERATED_BACKEND_ROUTES, 'utf8')
  const matches = source.matchAll(/resolvePageRouteMetadata\("([^"]+)"/g)
  return new Set(Array.from(matches, (match) => match[1]))
}

function readAppDictionary(locale: string): Record<string, string> {
  const raw = fs.readFileSync(path.resolve(APP_ROOT, 'i18n', `${locale}.json`), 'utf8')
  return JSON.parse(raw) as Record<string, string>
}

const SETTINGS_GROUP_IDS = ['app.nav.groups.pricingPolicy', 'app.nav.groups.serviceCosts']

describe('distributor workspace navigation groups', () => {
  const generatedPaths = readGeneratedBackendRoutePaths()

  it('reads a non-empty generated backend route registry', () => {
    expect(generatedPaths.size).toBeGreaterThan(0)
  })

  it('declares no empty group', () => {
    const empty = distributorNavGroups.filter((group) => group.pages.length === 0).map((group) => group.id)
    expect(empty).toEqual([])
  })

  it('points every override at a path the generator actually emitted', () => {
    const missing = Object.keys(distributorNavPageOverrides).filter((page) => !generatedPaths.has(page))
    expect(missing).toEqual([])
  })

  it('names no grouped page in the hidden list', () => {
    const hidden = new Set(distributorNavHiddenPages)
    const conflicting = distributorNavGroups.flatMap((group) =>
      group.pages.filter((page) => hidden.has(page.path)).map((page) => `${page.path} in ${group.id}`),
    )
    expect(conflicting).toEqual([])
  })

  /**
   * `navHidden` removes the sidebar entry and nothing else: `applyPageOverridesToManifests` keeps
   * the manifest entry's `load`, so the page still renders for anyone who follows the URL. An
   * override that also carried `group` or `priority` would be describing a sidebar slot that no
   * longer exists, so the hidden entries are asserted to carry that one key alone.
   */
  it('hides a page from the sidebar without re-homing or unregistering it', () => {
    expect(distributorNavHiddenPages.length).toBeGreaterThan(0)
    expect(new Set(distributorNavHiddenPages).size).toBe(distributorNavHiddenPages.length)
    for (const path of distributorNavHiddenPages) {
      expect(generatedPaths.has(path)).toBe(true)
      expect(distributorNavPageOverrides[path]).toEqual({ metadata: { navHidden: true } })
    }
  })

  /**
   * Only the list screens are compared: each rate table also emits `/create` and `/[id]` routes,
   * which the sidebar never renders (the `[id]` form is filtered on the bracket, and the create
   * form is reached from its list), so grouping them would assert over pages no operator navigates
   * to from the menu. The point under test is that no rate table escaped the two settings groups —
   * the owner's pricing policy and the cost-to-serve inputs.
   */
  it('keeps every pricing rate table in the two settings groups', () => {
    const params = Array.from(generatedPaths).filter((page) =>
      /^\/backend\/pricing\/params\/[^/]+$/.test(page),
    )
    const settings = distributorNavGroups.filter((group) => SETTINGS_GROUP_IDS.includes(group.id))
    expect(settings.map((group) => group.id)).toEqual(SETTINGS_GROUP_IDS)
    const grouped = new Set(settings.flatMap((group) => group.pages.map((page) => page.path)))
    expect(params.filter((page) => !grouped.has(page))).toEqual([])
    expect(grouped.size).toBe(params.length)
  })

  it('ranks the settings groups behind every other group it declares', () => {
    expect(distributorNavGroupOrder.slice(-SETTINGS_GROUP_IDS.length)).toEqual(SETTINGS_GROUP_IDS)
  })

  it('opens with the sales loop, in the order the day runs it', () => {
    expect(distributorNavGroupOrder[0]).toBe('app.nav.groups.sales')
    const sales = distributorNavGroups.find((group) => group.id === 'app.nav.groups.sales')
    expect(sales?.pages.map((page) => page.path)).toEqual([
      '/backend/predicted-orders',
      '/backend/sales/quotes',
      '/backend/sales/orders',
    ])
  })

  it('assigns each page to exactly one group', () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const group of distributorNavGroups) {
      for (const page of group.pages) {
        const owner = seen.get(page.path)
        if (owner) duplicates.push(`${page.path} claimed by ${owner} and ${group.id}`)
        else seen.set(page.path, group.id)
      }
    }
    expect(duplicates).toEqual([])
    expect(seen.size + distributorNavHiddenPages.length).toBe(Object.keys(distributorNavPageOverrides).length)
  })

  it('orders pages within a group deterministically', () => {
    const repeated = distributorNavGroups
      .filter((group) => new Set(group.pages.map((page) => page.priority)).size !== group.pages.length)
      .map((group) => group.id)
    expect(repeated).toEqual([])
  })

  it('overrides the group id, its fallback label and the sort priority of every page', () => {
    for (const group of distributorNavGroups) {
      for (const page of group.pages) {
        expect(distributorNavPageOverrides[page.path]).toEqual({
          metadata: {
            group: group.defaultName,
            groupKey: group.id,
            priority: page.priority,
            ...(page.titleKey ? { titleKey: page.titleKey, title: page.title } : {}),
          },
        })
      }
    }
  })

  it('orders exactly the groups it declares', () => {
    expect(distributorNavGroupOrder).toEqual(distributorNavGroups.map((group) => group.id))
    expect(new Set(distributorNavGroupOrder).size).toBe(distributorNavGroupOrder.length)
  })

  it('applies both overrides through the distributor_workspace module entry', () => {
    const entry = enabledModules.find((module) => module.id === 'distributor_workspace')
    expect(entry).toBeDefined()
    expect(entry?.overrides?.routes?.pages).toBe(distributorNavPageOverrides)

    const groupOrder = entry?.overrides?.nav?.groupOrder ?? []
    expect(groupOrder.slice(groupOrder.length - distributorNavGroupOrder.length)).toEqual([
      ...distributorNavGroupOrder,
    ])
  })

  it('declares no dictionary entry for a group it no longer renders', () => {
    const declared = new Set(distributorNavGroups.map((group) => group.id))
    const stale: string[] = []
    for (const locale of ['en', 'pl']) {
      const dictionary = readAppDictionary(locale)
      for (const key of Object.keys(dictionary)) {
        if (key.startsWith('app.nav.groups.') && !declared.has(key)) stale.push(`${locale}.json:${key}`)
      }
    }
    expect(stale).toEqual([])
  })

  it('translates every renamed page title in the app dictionaries the sidebar reads', () => {
    const renamed = distributorNavGroups.flatMap((group) => group.pages.filter((page) => page.titleKey))
    expect(renamed.length).toBeGreaterThan(0)
    const untranslated: string[] = []
    for (const locale of ['en', 'pl']) {
      const dictionary = readAppDictionary(locale)
      for (const page of renamed) {
        const value = dictionary[page.titleKey as string]
        if (typeof value !== 'string' || value.trim().length === 0) untranslated.push(`${locale}.json:${page.titleKey}`)
      }
    }
    expect(untranslated).toEqual([])
  })

  it('translates every group title in the app dictionaries the sidebar reads', () => {
    const untranslated: string[] = []
    for (const locale of ['en', 'pl']) {
      const dictionary = readAppDictionary(locale)
      for (const group of distributorNavGroups) {
        const value = dictionary[group.id]
        if (typeof value !== 'string' || value.trim().length === 0) untranslated.push(`${locale}.json:${group.id}`)
      }
    }
    expect(untranslated).toEqual([])
  })
})
