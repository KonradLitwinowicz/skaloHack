'use client'

import * as React from 'react'
import { Trash2 } from 'lucide-react'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { CounterInput } from '@open-mercato/ui/primitives/counter-input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { AdvisorVolumeSensitivity } from '../../../lib/frontend/advisorTypes'
import type { DeskLine, LineFloor, MarginTargets } from '../../../lib/frontend/basketDesk'
import { formatMoney } from '../../../lib/frontend/marginMath'
import type { QuoteBreakdownComponent, QuoteLine, QuoteResponse } from '../../../lib/frontend/quoteTypes'

export type BasketTableProps = {
  lines: DeskLine[]
  quote: QuoteResponse | null
  floors: Map<string, LineFloor>
  targets: MarginTargets
  currencyCode: string
  selectedProductId: string | null
  pending: boolean
  volume: AdvisorVolumeSensitivity | null
  onSelect: (productId: string) => void
  onQuantityChange: (key: string, quantity: number | null) => void
  onRemove: (key: string) => void
}

type MarginTone = 'ok' | 'belowTarget' | 'belowFloor'

function toNumber(value: string | null | undefined): number {
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function marginTone(marginPercent: string, targets: MarginTargets): MarginTone {
  const margin = toNumber(marginPercent)
  if (targets.floorMarginPercent !== null && margin < toNumber(targets.floorMarginPercent)) return 'belowFloor'
  if (targets.targetMarginPercent !== null && margin < toNumber(targets.targetMarginPercent)) return 'belowTarget'
  return 'ok'
}

const PRODUCT_COST_CODE = 'product_cost'

/**
 * What we paid for one unit, straight off the pipeline's own `product_cost` component.
 *
 * This is the only figure on the row that does NOT move with quantity — the handling cost does,
 * because it is charged per document and per line and then spread over the units. Showing the two
 * side by side is the point: the operator adding a line can see what the goods cost us and watch
 * the rest come down as the quantity goes up.
 *
 * Returns null when the component is missing, and `unknown: true` when it is there but reports
 * zero on `default` confidence — the engine's way of saying no purchase price is recorded. A zero
 * printed as "0,00 zl" would read as a free product rather than as a gap in the data.
 */
function purchaseUnitCostOf(
  quoted: { breakdown?: QuoteBreakdownComponent[] } | null,
): { value: string; unknown: boolean } | null {
  const component = quoted?.breakdown?.find((entry) => entry.code === PRODUCT_COST_CODE)
  if (!component) return null
  const unknown = component.confidence === 'default' && toNumber(component.value) === 0
  return { value: component.value, unknown }
}

const TONE_VARIANT: Record<MarginTone, 'success' | 'warning' | 'error'> = {
  ok: 'success',
  belowTarget: 'warning',
  belowFloor: 'error',
}

/**
 * The basket and the engine's answer on one row each. Every figure a rep negotiates with — unit
 * price, unit cost, margin, the lowest the price may go — sits next to the quantity that
 * produced it, so changing the quantity and watching the row move is the whole interaction.
 */
export function BasketTable({
  lines,
  quote,
  floors,
  targets,
  currencyCode,
  selectedProductId,
  pending,
  volume,
  onSelect,
  onQuantityChange,
  onRemove,
}: BasketTableProps) {
  const t = useT()
  const quotedByProduct = React.useMemo(() => {
    const map = new Map<string, QuoteLine>()
    for (const line of quote?.lines ?? []) map.set(line.productId, line)
    return map
  }, [quote])

  const dim = pending ? 'opacity-60 transition-opacity' : 'transition-opacity'

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table className="min-w-[56rem]">
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-64">{t('pricing_engine.desk.column.product', 'Product')}</TableHead>
            <TableHead className="w-40">{t('pricing_engine.desk.column.quantity', 'Quantity')}</TableHead>
            <TableHead className="text-right">{t('pricing_engine.desk.column.unitPrice', 'Unit price')}</TableHead>
            <TableHead className="text-right">
              {t('pricing_engine.desk.column.purchaseCost', 'We paid')}
            </TableHead>
            <TableHead className="text-right">
              {t('pricing_engine.desk.column.unitCost', 'Unit cost with handling')}
            </TableHead>
            <TableHead className="text-right">{t('pricing_engine.desk.column.margin', 'Margin')}</TableHead>
            <TableHead className="text-right">{t('pricing_engine.desk.column.floor', 'Lowest price')}</TableHead>
            <TableHead className="text-right">{t('pricing_engine.desk.column.lineTotal', 'Line total')}</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const quoted = quotedByProduct.get(line.productId) ?? null
            const floor = floors.get(line.productId) ?? null
            const selected = line.productId === selectedProductId
            const tone = quoted ? marginTone(quoted.marginPercent, targets) : null
            const showLadder = selected && volume && volume.productId === line.productId && volume.points.length > 1
            return (
              <React.Fragment key={line.key}>
                <TableRow
                  className={`cursor-pointer ${selected ? 'bg-accent/40' : 'hover:bg-accent/20'}`}
                  onClick={() => onSelect(line.productId)}
                  aria-selected={selected}
                >
                  <TableCell className="min-w-64">
                    <div className="font-medium">{line.title}</div>
                    {line.sku ? <div className="text-xs text-muted-foreground">{line.sku}</div> : null}
                  </TableCell>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <CounterInput
                      size="sm"
                      min={1}
                      step={1}
                      value={line.quantity}
                      onChange={(next) => onQuantityChange(line.key, next)}
                      aria-label={t('pricing_engine.desk.column.quantity', 'Quantity')}
                      decrementAriaLabel={t('pricing_engine.ui.counter.decrease', 'Decrease quantity')}
                      incrementAriaLabel={t('pricing_engine.ui.counter.increase', 'Increase quantity')}
                    />
                  </TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${dim}`}>
                    {quoted ? formatMoney(quoted.unitPriceNet, currencyCode) : '—'}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums text-muted-foreground ${dim}`}>
                    {(() => {
                      const purchase = purchaseUnitCostOf(quoted)
                      if (!purchase) return '—'
                      if (purchase.unknown) {
                        return (
                          <span className="text-status-warning-text">
                            {t('pricing_engine.desk.column.purchaseCostUnknown', 'not recorded')}
                          </span>
                        )
                      }
                      const lineTotal = toNumber(purchase.value) * line.quantity
                      return (
                        <>
                          <div>{formatMoney(purchase.value, currencyCode)}</div>
                          {line.quantity > 1 ? (
                            // The row mixes per-unit columns with one line total ("Line total"),
                            // so a lone unit figure here reads as if two units cost the same as
                            // one. The second line says what the quantity on this row actually
                            // cost us, in the same shape the floor cell already uses.
                            <div className="text-xs text-muted-foreground">
                              {`×${line.quantity} = ${formatMoney(String(lineTotal), currencyCode)}`}
                            </div>
                          ) : null}
                        </>
                      )
                    })()}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums text-muted-foreground ${dim}`}>
                    {quoted ? formatMoney(quoted.unitCostNet, currencyCode) : '—'}
                  </TableCell>
                  <TableCell className={`text-right ${dim}`}>
                    {quoted && tone ? (
                      <Badge variant={TONE_VARIANT[tone]} size="sm">
                        {toNumber(quoted.marginPercent).toFixed(1)} %
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${dim}`}>
                    {floor?.lowestUnitPrice ? (
                      <div>
                        <div>{formatMoney(floor.lowestUnitPrice, currencyCode)}</div>
                        {floor.discountHeadroomPercent ? (
                          <div className="text-xs text-muted-foreground">
                            {t('pricing_engine.desk.floor.headroom', '{percent}% of room', {
                              percent: toNumber(floor.discountHeadroomPercent).toFixed(1),
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : quoted ? (
                      <span className="text-xs text-muted-foreground">
                        {t('pricing_engine.desk.floor.none', 'no guardrail')}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${dim}`}>
                    {quoted ? formatMoney(quoted.totalPriceNet, currencyCode) : '—'}
                  </TableCell>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('pricing_engine.calculator.action.removeLine', 'Remove this line')}
                      onClick={() => onRemove(line.key)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </TableCell>
                </TableRow>
                {showLadder ? (
                  <TableRow className="bg-accent/20">
                    <TableCell colSpan={9} className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {t('pricing_engine.desk.ladder.label', 'What if they took')}
                        </span>
                        {volume.points.map((point) => {
                          const quantity = Number(point.quantity)
                          const isCurrent = quantity === line.quantity
                          return (
                            <Button
                              key={point.quantity}
                              type="button"
                              size="sm"
                              variant={isCurrent ? 'default' : 'outline'}
                              onClick={() => onQuantityChange(line.key, quantity)}
                              title={t('pricing_engine.desk.ladder.pointHint', 'Margin {margin}% · profit on the line {profit}', {
                                margin: toNumber(point.marginPercent).toFixed(1),
                                profit: formatMoney(point.lineProfitNet, volume.currencyCode),
                              })}
                            >
                              <span className="tabular-nums">×{point.quantity}</span>
                              <span className="ml-1 text-xs tabular-nums opacity-80">
                                {formatMoney(point.unitPriceNet, volume.currencyCode)}
                              </span>
                              {point.crossesNextTierVolume ? (
                                <span className="ml-1 text-xs">↑</span>
                              ) : null}
                            </Button>
                          )
                        })}
                        <span className="text-xs text-muted-foreground">
                          {t('pricing_engine.desk.ladder.hint', 'Click a rung to set that quantity. ↑ marks a quantity that reaches your next purchase tier.')}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </React.Fragment>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

export default BasketTable
