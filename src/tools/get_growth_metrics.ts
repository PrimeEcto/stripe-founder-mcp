import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { computeSubscriptionMonthlyMrrCents, getSubscriptionCurrency } from "../lib/billing.js";
import { formatMoney } from "../lib/money.js";
import { normalizeDateRange } from "../lib/dates.js";
import { executeCachedTool } from "../lib/tool_execution.js";
import type { ToolResult } from "../lib/types.js";
import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

const growthMetricsInputSchema = z.object({
  period: z
    .union([
      z.string(),
      z.object({
        end: z.string().describe("ISO 8601 UTC end timestamp for the requested growth window."),
        start: z.string().describe("ISO 8601 UTC start timestamp for the requested growth window.")
      })
    ])
    .optional()
    .describe("Optional period input. Defaults to this_month and accepts ISO ranges, last_30_days, 2026-Q1, or March 2026.")
});

type GrowthMetricsInput = z.infer<typeof growthMetricsInputSchema>;

interface GrowthMetricsSummary {
  churned_mrr: number;
  churned_mrr_formatted: string;
  contraction_mrr: number;
  contraction_mrr_formatted: string;
  expansion_mrr: number;
  expansion_mrr_formatted: string;
  gross_churn_rate_pct: number;
  growth_rate_pct: number;
  mrr_end_cents: number;
  mrr_end_formatted: string;
  mrr_start_cents: number;
  mrr_start_formatted: string;
  net_churn_rate_pct: number;
  net_new_mrr: number;
  net_new_mrr_formatted: string;
  new_mrr: number;
  new_mrr_formatted: string;
}

interface GrowthMetricsContext {
  caveats: string[];
  currency_breakdown?: Record<string, GrowthMetricsSummary>;
  period_label: string;
  stripe_mode: "live" | "test";
  truncated: boolean;
}

type GrowthMetricsResult = ToolResult<GrowthMetricsSummary, GrowthMetricsContext, Record<string, never>>;

function calculateRate(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return numerator === 0 ? 0 : 100;
  }

  return Number(((numerator / denominator) * 100).toFixed(2));
}

async function loadGrowthMetrics(args: GrowthMetricsInput): Promise<GrowthMetricsResult> {
  const stripeClient = getStripeClientContext();
  const period = normalizeDateRange(args.period, new Date(), "this_month");
  const periodEndPoint = new Date(period.end.getTime() - 1);

  const subscriptions = await stripeClient.getCachedToolResult("get_growth_metrics:subscriptions", args, async () =>
    collectAutoPaged(
      stripeClient.stripe.subscriptions.list({
        expand: ["data.items.data.price"],
        status: "all"
      }),
      stripeClient.maxListResults
    )
  );

  const currencyTotals = new Map<string, {
    churnedMrr: number;
    contractionMrr: number;
    expansionMrr: number;
    mrrEnd: number;
    mrrStart: number;
    newMrr: number;
  }>();

  for (const subscription of subscriptions.items) {
    const currency = getSubscriptionCurrency(subscription).toLowerCase();
    if (!currencyTotals.has(currency)) {
      currencyTotals.set(currency, { churnedMrr: 0, contractionMrr: 0, expansionMrr: 0, mrrEnd: 0, mrrStart: 0, newMrr: 0 });
    }
    const totals = currencyTotals.get(currency)!;

    const startMrr = computeSubscriptionMonthlyMrrCents(subscription, period.start);
    const endMrr = computeSubscriptionMonthlyMrrCents(subscription, periodEndPoint);

    totals.mrrStart += startMrr;
    totals.mrrEnd += endMrr;

    const createdAt = subscription.created * 1000;
    const canceledAt = (subscription.canceled_at ?? subscription.ended_at ?? 0) * 1000;

    if (createdAt >= period.start.getTime() && createdAt < period.end.getTime() && endMrr > 0) {
      totals.newMrr += endMrr;
    }

    if (canceledAt >= period.start.getTime() && canceledAt < period.end.getTime() && startMrr > 0) {
      totals.churnedMrr += startMrr;
    }

    if (createdAt < period.start.getTime()) {
      if (endMrr > startMrr) {
        totals.expansionMrr += endMrr - startMrr;
      } else if (startMrr > endMrr) {
        totals.contractionMrr += startMrr - endMrr;
      }
    }
  }

  function buildSummary(t: typeof currencyTotals extends Map<string, infer V> ? V : never, curr: string | null): GrowthMetricsSummary {
    const netNewMrr = t.newMrr + t.expansionMrr - t.contractionMrr - t.churnedMrr;
    const fmt = (cents: number) => curr ? formatMoney(cents, curr).formatted : "Multi-currency (see context)";

    return {
      churned_mrr: t.churnedMrr,
      churned_mrr_formatted: fmt(t.churnedMrr),
      contraction_mrr: t.contractionMrr,
      contraction_mrr_formatted: fmt(t.contractionMrr),
      expansion_mrr: t.expansionMrr,
      expansion_mrr_formatted: fmt(t.expansionMrr),
      gross_churn_rate_pct: calculateRate(t.churnedMrr, t.mrrStart),
      growth_rate_pct: calculateRate(netNewMrr, t.mrrStart),
      mrr_end_cents: t.mrrEnd,
      mrr_end_formatted: fmt(t.mrrEnd),
      mrr_start_cents: t.mrrStart,
      mrr_start_formatted: fmt(t.mrrStart),
      net_churn_rate_pct: calculateRate(t.churnedMrr - t.expansionMrr, t.mrrStart),
      net_new_mrr: netNewMrr,
      net_new_mrr_formatted: fmt(netNewMrr),
      new_mrr: t.newMrr,
      new_mrr_formatted: fmt(t.newMrr)
    };
  }

  let summary: GrowthMetricsSummary;
  const currencyBreakdown: Record<string, GrowthMetricsSummary> = {};

  if (currencyTotals.size === 0) {
    summary = buildSummary({ churnedMrr: 0, contractionMrr: 0, expansionMrr: 0, mrrEnd: 0, mrrStart: 0, newMrr: 0 }, "usd");
  } else if (currencyTotals.size === 1) {
    const [currency, totals] = Array.from(currencyTotals.entries())[0]!;
    summary = buildSummary(totals, currency);
  } else {
    const aggregate = { churnedMrr: 0, contractionMrr: 0, expansionMrr: 0, mrrEnd: 0, mrrStart: 0, newMrr: 0 };
    for (const [currency, totals] of currencyTotals.entries()) {
      currencyBreakdown[currency] = buildSummary(totals, currency);
      aggregate.churnedMrr += totals.churnedMrr;
      aggregate.contractionMrr += totals.contractionMrr;
      aggregate.expansionMrr += totals.expansionMrr;
      aggregate.mrrEnd += totals.mrrEnd;
      aggregate.mrrStart += totals.mrrStart;
      aggregate.newMrr += totals.newMrr;
    }
    summary = buildSummary(aggregate, null);
  }

  const caveats = [
    "MRR includes only active and past_due subscriptions.",
    "Expansion and contraction are derived from observable subscription value changes between the start and end of the requested period."
  ];

  if (currencyTotals.size > 1) {
    caveats.push("Multi-currency account — totals shown per currency in context, not FX-converted.");
  }

  return {
    context: {
      caveats,
      ...(currencyTotals.size > 1 ? { currency_breakdown: currencyBreakdown } : {}),
      period_label: period.label,
      stripe_mode: stripeClient.mode,
      truncated: subscriptions.truncated
    },
    items: [],
    summary
  };
}

export const getGrowthMetricsTool: Tool<FastMCPSessionAuth, typeof growthMetricsInputSchema> = {
  description: "Show founder-focused growth metrics for a period, including new MRR, churn, and net new MRR.",
  name: "get_growth_metrics",
  parameters: growthMetricsInputSchema,
  async execute(args) {
    return executeCachedTool("get_growth_metrics", args, async () => loadGrowthMetrics(args));
  }
};
