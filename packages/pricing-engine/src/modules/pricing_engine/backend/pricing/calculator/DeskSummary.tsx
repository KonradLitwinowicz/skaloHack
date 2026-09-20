"use client";

import * as React from "react";
import { Check, Copy, FileText, ShoppingCart } from "lucide-react";
import { KpiCard } from "@open-mercato/ui/backend/charts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@open-mercato/ui/primitives/alert";
import { Badge } from "@open-mercato/ui/primitives/badge";
import { Button } from "@open-mercato/ui/primitives/button";
import { Kbd } from "@open-mercato/ui/primitives/kbd";
import { useT } from "@open-mercato/shared/lib/i18n/context";
import { SimpleTooltip } from "@open-mercato/ui/primitives/tooltip";
import { summariseBasketCost } from "../../../lib/frontend/costBreakdown";
import type { MarginTargets } from "../../../lib/frontend/basketDesk";
import { basketMargin, formatMoney } from "../../../lib/frontend/marginMath";
import type { QuoteResponse } from "../../../lib/frontend/quoteTypes";

export type DeskSummaryProps = {
  quote: QuoteResponse | null;
  currencyCode: string;
  targets: MarginTargets;
  lineCount: number;
  pending: boolean;
  error: string | null;
  creating: "quote" | "order" | null;
  copied: boolean;
  onCreateQuote: () => void;
  onCreateOrder: () => void;
  onCopyLink: () => void;
  onRetry: () => void;
};

function toNumber(value: string | null | undefined): number {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The four numbers a deal is decided on and the two ways out of the screen, above the basket so
 * the totals are read before any line is negotiated.
 */
export function DeskSummary({
  quote,
  currencyCode,
  targets,
  lineCount,
  pending,
  error,
  creating,
  copied,
  onCreateQuote,
  onCreateOrder,
  onCopyLink,
  onRetry,
}: DeskSummaryProps) {
  const t = useT();
  const money = React.useCallback(
    (value: number) => formatMoney(String(value), currencyCode),
    [currencyCode],
  );
  const totals = quote
    ? basketMargin([
        {
          unitPriceNet: quote.totalNet,
          unitCostNet: quote.totalCostNet,
          quantity: "1",
        },
      ])
    : null;
  const margin = totals ? toNumber(totals.marginPercent) : null;

  // What the full cost is made of. The card used to print one number and call it the cost to
  // serve, which hid both that most of it is usually the goods and that the rest moves with
  // quantity — the per-document and per-line parts are spread over the units.
  const costs = React.useMemo(() => summariseBasketCost(quote), [quote]);
  const costTooltip = costs ? (
    <div className="space-y-1">
      <div className="font-medium">
        {t("pricing_engine.desk.summary.costBreakdown", "What the cost is made of")}
      </div>
      {costs.components.map((component) => (
        <div key={component.code} className="flex items-baseline justify-between gap-4 tabular-nums">
          <span>{t(component.labelKey, component.code)}</span>
          <span>{money(component.amount)}</span>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-4 border-t border-border pt-1 tabular-nums font-medium">
        <span>{t("pricing_engine.desk.summary.costHandling", "handling in total")}</span>
        <span>{money(costs.handling)}</span>
      </div>
    </div>
  ) : null;
  const belowFloor =
    margin !== null &&
    targets.floorMarginPercent !== null &&
    margin < toNumber(targets.floorMarginPercent);
  const belowTarget =
    !belowFloor &&
    margin !== null &&
    targets.targetMarginPercent !== null &&
    margin < toNumber(targets.targetMarginPercent);
  const canCreate =
    Boolean(quote) && lineCount > 0 && !pending && creating === null;
  const warnings = quote?.warnings ?? [];

  const marginFooter = belowFloor ? (
    <Badge variant="error" size="sm">
      {t("pricing_engine.margin.kpi.belowFloor", "Below the minimum margin")}
    </Badge>
  ) : belowTarget ? (
    <Badge variant="warning" size="sm">
      {t("pricing_engine.margin.kpi.belowTarget", "Below the target margin")}
    </Badge>
  ) : targets.targetMarginPercent && margin !== null ? (
    <Badge variant="success" size="sm">
      {t("pricing_engine.desk.summary.onTarget", "On target ({target}%)", {
        target: toNumber(targets.targetMarginPercent).toFixed(1),
      })}
    </Badge>
  ) : undefined;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          title={t(
            "pricing_engine.desk.summary.revenue",
            "Customer pays (net)",
          )}
          value={totals ? toNumber(totals.revenueNet) : null}
          formatValue={money}
          loading={pending && !quote}
        />
        <KpiCard
          title={t("pricing_engine.desk.summary.profit", "You keep (net)")}
          value={totals ? toNumber(totals.profitNet) : null}
          formatValue={money}
          loading={pending && !quote}
          footer={
            totals && toNumber(totals.profitNet) < 0 ? (
              <Badge variant="error" size="sm">
                {t(
                  "pricing_engine.margin.kpi.lossMaking",
                  "This document sells below cost",
                )}
              </Badge>
            ) : undefined
          }
        />
        <KpiCard
          title={t("pricing_engine.margin.kpi.margin", "Margin on price")}
          value={margin}
          formatValue={(value) => value.toFixed(1)}
          suffix="%"
          loading={pending && !quote}
          footer={marginFooter}
        />
        <SimpleTooltip side="bottom" content={costTooltip}>
          <div>
            <KpiCard
              title={t("pricing_engine.desk.summary.cost", "Full cost")}
              value={totals ? toNumber(totals.costNet) : null}
              formatValue={money}
              loading={pending && !quote}
              footer={
                costs ? (
                  <span className="text-xs text-muted-foreground">
                    {t("pricing_engine.desk.summary.costGoodsShare", "goods {amount}", {
                      amount: money(costs.goods),
                    })}
                  </span>
                ) : undefined
              }
            />
          </div>
        </SimpleTooltip>
      </div>

      <div className="space-y-2 rounded-lg border border-border bg-card p-3 lg:row-span-2">
        <div className="text-overline font-semibold uppercase tracking-widest text-muted-foreground">
          {t("pricing_engine.desk.actions.title", "And off we go")}
        </div>
        <Button
          type="button"
          className="w-full"
          disabled={!canCreate}
          onClick={onCreateQuote}
        >
          <FileText className="h-4 w-4" />
          {creating === "quote"
            ? t("pricing_engine.desk.actions.creating", "Creating…")
            : t("pricing_engine.desk.actions.createQuote", "Save as a quote")}
          <Kbd className="ml-auto">⌘↵</Kbd>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={!canCreate}
          onClick={onCreateOrder}
        >
          <ShoppingCart className="h-4 w-4" />
          {creating === "order"
            ? t("pricing_engine.desk.actions.creating", "Creating…")
            : t(
                "pricing_engine.desk.actions.createOrder",
                "Straight to an order",
              )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={lineCount === 0}
          onClick={onCopyLink}
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          {copied
            ? t("pricing_engine.desk.actions.copied", "Link copied")
            : t(
                "pricing_engine.desk.actions.copyLink",
                "Copy a link to this basket",
              )}
        </Button>
        <p className="text-xs text-muted-foreground">
          {t(
            "pricing_engine.desk.actions.hint",
            "The document takes the engine prices as they stand here. Nothing is written until you save.",
          )}
        </p>
      </div>

      <div className="space-y-2">
        {pending && quote ? (
          <p className="text-xs text-muted-foreground">
            {t("pricing_engine.desk.summary.repricing", "Repricing…")}
          </p>
        ) : null}

        {error ? (
          <Alert status="error" style="lighter" size="sm">
            <AlertTitle>{error}</AlertTitle>
            <AlertDescription>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
              >
                {t("pricing_engine.margin.retry", "Try again")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {warnings.length > 0 ? (
          <Alert status="warning" style="lighter" size="sm">
            <AlertTitle>
              {t(
                "pricing_engine.margin.warnings.title",
                "What this price could not account for",
              )}
            </AlertTitle>
            <AlertDescription>
              {warnings.map((warning) => (
                <span key={warning} className="block">
                  {t(warning, warning)}
                </span>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}

export default DeskSummary;
