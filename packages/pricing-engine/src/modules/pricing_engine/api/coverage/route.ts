import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PricingCoverageEntry } from '../../data/entities'
import { coverageResponseSchema } from '../../data/validators'
import { PIPELINE_COMPONENT_CODES, implementedComponents } from '../../lib/components'
import { resolvePricingRouteContext } from '../../lib/api/context'

const logger = createLogger('pricing_engine')

export const metadata = {
  path: '/pricing/coverage',
  GET: { requireAuth: true, requireFeatures: ['pricing.audit.read'] },
}

// The register is built from the pipeline definition, not from whatever rows happen to exist, so a
// component with no coverage row shows up as missing instead of vanishing from the list.
export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const em = ctx.container.resolve('em') as EntityManager
    const rows = await em.find(PricingCoverageEntry, {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      deletedAt: null,
    })
    const byCode = new Map(rows.map((row) => [row.componentCode, row]))
    const implementedCodes = new Set(implementedComponents.map((component) => component.code))

    const items = PIPELINE_COMPONENT_CODES.map((code) => {
      const row = byCode.get(code) ?? null
      const implemented = implementedCodes.has(code)
      return {
        componentCode: code,
        labelKey: `pricing_engine.components.${toCamelCase(code)}.label`,
        implemented,
        sourceKind: row?.sourceKind ?? 'none',
        sourceRef: row?.sourceRef ?? null,
        freshnessDays: row?.freshnessDays ?? null,
        confidence: row?.confidence ?? 'default',
        missingReasonKey: implemented
          ? row?.missingReasonKey ?? null
          : 'pricing_engine.coverage.reason.notImplemented',
        lastCheckedAt: row?.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
      }
    })

    return NextResponse.json(coverageResponseSchema.parse({ items }))
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    logger.error('Pricing coverage lookup failed', { error: err })
    return NextResponse.json({ error: 'pricing_engine.errors.coverageFailed' }, { status: 500 })
  }
}

function toCamelCase(code: string): string {
  return code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Data coverage register',
  methods: {
    GET: {
      summary: 'List every pipeline component with its data source, freshness and confidence',
      responses: [
        { status: 200, description: 'Coverage register', schema: coverageResponseSchema },
      ],
    },
  },
}
