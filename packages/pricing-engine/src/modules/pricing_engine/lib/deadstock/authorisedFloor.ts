import type { EntityManager } from '@mikro-orm/postgresql'
import { toDecimal } from '../decimal'
import type { Decimal } from '../decimal'
import { PricingDeadstockDecision } from '../../data/entities'
import type { DeadstockMarkdownStage } from './markdown'
import { isUndefinedTableError, reportMissingTableOnce } from './missingTable'

/**
 * A deadstock floor the pipeline is allowed to honour.
 *
 * ## Why a quote does not compute this for itself
 *
 * The shelf-life ladder can read a lot's expiry date off the stock it is already holding. Deadstock
 * cannot: the signal is fourteen months of sales history, and re-deriving it inside a fifty-line
 * basket would turn one quote into a catalogue-wide analysis. More importantly it SHOULD not — an
 * automatic below-cost floor appearing in a quote because a heuristic decided a product looked
 * quiet is exactly the behaviour the whole feature is built to avoid.
 *
 * So the floor is authorised, not inferred. A person looked at the figures on the deadstock screen,
 * confirmed the verdict, and that act stored the floor it was based on. The pipeline reads back
 * what a human approved, and the snapshot makes the approval auditable: the numbers in it are the
 * numbers that were on screen, not the numbers the same query would return today.
 */
export type AuthorisedDeadstockFloor = {
  decisionId: string
  productId: string
  floorUnitPrice: Decimal
  stage: DeadstockMarkdownStage
  decidedAt: Date
  /** Purchase cost at the moment of the decision, for the below-cost figure the panel prints. */
  purchaseUnitCost: Decimal | null
}

export type AuthorisedDeadstockFloors = {
  byProductId: Map<string, AuthorisedDeadstockFloor>
}

export function emptyAuthorisedFloors(): AuthorisedDeadstockFloors {
  return { byProductId: new Map() }
}

const MARKDOWN_STAGES: DeadstockMarkdownStage[] = ['dying', 'dead', 'never_sold']

function readSnapshotFloor(
  decision: PricingDeadstockDecision,
): { floorUnitPrice: Decimal; stage: DeadstockMarkdownStage; purchaseUnitCost: Decimal | null } | null {
  const snapshot = decision.snapshot
  if (!snapshot) return null
  const markdown = snapshot['markdown']
  if (!markdown || typeof markdown !== 'object') return null
  const record = markdown as Record<string, unknown>
  const floor = record['floorUnitPrice']
  const stage = record['stage']
  if (typeof floor !== 'string') return null
  if (typeof stage !== 'string' || !MARKDOWN_STAGES.includes(stage as DeadstockMarkdownStage)) return null
  const cost = snapshot['unitCost']
  return {
    floorUnitPrice: toDecimal(floor),
    stage: stage as DeadstockMarkdownStage,
    purchaseUnitCost: typeof cost === 'string' ? toDecimal(cost) : null,
  }
}

/**
 * The floors in force for these products, one query.
 *
 * A confirmation expires the same way a dismissal does. An authorisation to sell below cost that
 * outlives the situation that justified it is a standing discount nobody remembers granting, so a
 * `reviewAt` in the past closes the floor and the product prices normally again.
 */
export async function loadAuthorisedDeadstockFloors(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  productIds: string[],
  asOf: Date,
): Promise<AuthorisedDeadstockFloors> {
  const uniqueIds = Array.from(new Set(productIds.filter(Boolean)))
  if (uniqueIds.length === 0) return emptyAuthorisedFloors()

  // This runs on EVERY quote, and the table it reads arrives with a migration.
  //
  // `AGENTS.md` is explicit that a pull request ships migration FILES and that applying them is the
  // owner's decision, so "code deployed, migration not yet applied" is a normal state of this repo,
  // not an incident — and it is also what a fresh install looks like before its first migrate. A
  // feature that takes the whole pricing engine down in that window is too brittle regardless of
  // how quickly anyone runs the command. No authorisations can exist without the table, so the
  // honest reading of its absence is an empty set, and every quote prices exactly as it did before
  // this feature existed.
  let rows: PricingDeadstockDecision[]
  try {
    rows = await em.find(PricingDeadstockDecision, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
      catalogProductId: { $in: uniqueIds },
    })
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error
    reportMissingTableOnce('pricing_deadstock_decisions')
    return emptyAuthorisedFloors()
  }

  // Latest decision per product wins, whatever it says. A dismissal that came after a confirmation
  // revokes it, which is the only way an operator can take an authorisation back.
  const latestByProduct = new Map<string, PricingDeadstockDecision>()
  for (const row of rows) {
    const current = latestByProduct.get(row.catalogProductId)
    if (!current || row.decidedAt.getTime() > current.decidedAt.getTime()) {
      latestByProduct.set(row.catalogProductId, row)
    }
  }

  const byProductId = new Map<string, AuthorisedDeadstockFloor>()
  for (const [productId, decision] of latestByProduct) {
    if (decision.verdict === 'dismissed') continue
    if (decision.reviewAt && decision.reviewAt.getTime() <= asOf.getTime()) continue
    const snapshot = readSnapshotFloor(decision)
    if (!snapshot) continue
    byProductId.set(productId, {
      decisionId: decision.id,
      productId,
      floorUnitPrice: snapshot.floorUnitPrice,
      stage: snapshot.stage,
      decidedAt: decision.decidedAt,
      purchaseUnitCost: snapshot.purchaseUnitCost,
    })
  }

  return { byProductId }
}
