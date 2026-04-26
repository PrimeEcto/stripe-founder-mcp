import type { FastMCPSessionAuth, Tool } from "fastmcp";
import type Stripe from "stripe";
import { z } from "zod";

import { computeSubscriptionMonthlyMrrCents, getSubscriptionCurrency } from "../lib/billing.js";
import { formatMoney } from "../lib/money.js";
import { normalizeDateRange } from "../lib/dates.js";
import { loadFailedPaymentRecords } from "../lib/failed_payments.js";
import { executeCachedTool } from "../lib/tool_execution.js";
import type { ToolResult } from "../lib/types.js";
import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

const INVOLUNTARY_REASONS = new Set(["payment_disputed", "payment_failed"]);

const churnSummaryInputSchema = z.object({
  period: z
    .union([
      z.string(),
      z.object({
        end: z.string().describe("ISO 8601 UTC end timestamp for the churn window."),
        start: z.string().describe("ISO 8601 UTC start timestamp for the churn window.")
      })
    ])
    .optional()
    .describe("Optional churn window. Defaults to this_month and accepts ISO ranges, last_30_days, 2026-Q1, or March 2026.")
});

type GetChurnSummaryInput = z.infer<typeof churnSummaryInputSchema>;

interface GetChurnSummarySummary {
  churned_mrr_cents: number;
  churned_mrr_formatted: string;
  gross_churn_rate_pct: number;
  involuntary_count: number;
  net_churn_rate_pct: number;
  total_churned_count: number;
  voluntary_count: number;
}

interface GetChurnSummaryContext {
  caveats: string[];
  currency_breakdown?: Record<string, GetChurnSummarySummary>;
  period_label: string;
  stripe_mode: "live" | "test";
  truncated: boolean;
}

interface GetChurnSummaryItem {
  count: number;
  mrr_cents: number;
  reason: string;
}

type GetChurnSummaryResult = ToolResult<GetChurnSummarySummary, GetChurnSummaryContext, GetChurnSummaryItem>;

function calculateRate(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }

  return Number(((numerator / denominator) * 100).toFixed(2));
}

function getCancellationTimestamp(subscription: Stripe.Subscription): number | null {
  return subscription.canceled_at ?? subscription.ended_at ?? null;
}

function classifyChurn(
  subscription: Stripe.Subscription,
  failedPayments: Awaited<ReturnType<typeof loadFailedPaymentRecords>>["records"]
): "involuntary" | "voluntary" {
  const cancellationReason = subscription.cancellation_details?.reason;
  if (cancellationReason && INVOLUNTARY_REASONS.has(cancellationReason)) {
    return "involuntary";
  }

  const canceledAt = getCancellationTimestamp(subscription);
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!canceledAt || !customerId) {
    return "voluntary";
  }

  const canceledAtMs = canceledAt * 1000;
  const relatedFailure = failedPayments.find((record) => {
    if (record.customer_id !== customerId && record.subscription_id !== subscription.id) {
      return false;
    }

    const attemptedAtMs = Date.parse(record.attempted_at_iso);
    return attemptedAtMs <= canceledAtMs && canceledAtMs - attemptedAtMs <= 7 * 24 * 60 * 60 * 1000;
  });

  return relatedFailure ? "involuntary" : "voluntary";
}

function getChurnReasonLabel(subscription: Stripe.Subscription, churnType: "involuntary" | "voluntary"): string {
  return (
    subscription.cancellation_details?.feedback ??
    subscription.cancellation_details?.reason ??
    (churnType === "involuntary" ? "payment_failed" : "unknown")
  );
}

async function loadSubscriptionsByStatus(
  status: Stripe.SubscriptionListParams.Status,
  cacheKey: string
): Promise<ReturnType<typeof collectAutoPaged<Stripe.Subscription>>> {
  const stripeClient = getStripeClientContext();

  return stripeClient.getCachedToolResult(cacheKey, { status }, async () =>
    collectAutoPaged(
      stripeClient.stripe.subscriptions.list({
        expand: ["data.items.data.price"],
        limit: 100,
        status
      }),
      stripeClient.maxListResults
    )
  );
}

async function loadChurnSummary(args: GetChurnSummaryInput): Promise<GetChurnSummaryResult> {
  const stripeClient = getStripeClientContext();
  const period = normalizeDateRange(args.period, new Date(), "this_month");
  const periodEndPoint = new Date(period.end.getTime() - 1);

  const [activeSubscriptions, pastDueSubscriptions, canceledSubscriptions, failedPayments] = await Promise.all([
    loadSubscriptionsByStatus("active", "get_churn_summary:active_subscriptions"),
    loadSubscriptionsByStatus("past_due", "get_churn_summary:past_due_subscriptions"),
    loadSubscriptionsByStatus("canceled", "get_churn_summary:canceled_subscriptions"),
    loadFailedPaymentRecords(period, "get_churn_summary:failed_payments")
  ]);
  const survivingSubscriptions = [...activeSubscriptions.items, ...pastDueSubscriptions.items];
  const allSubscriptions = [...survivingSubscriptions, ...canceledSubscriptions.items];

  const currencyTotals = new Map<string, {
    startingMrrCents: number;
    expansionMrrCents: number;
    churnedMrrCents: number;
    voluntaryCount: number;
    involuntaryCount: number;
  }>();

  const reasons = new Map<string, { count: number; mrr_cents: number }>();

  for (const subscription of allSubscriptions) {
    const currency = getSubscriptionCurrency(subscription).toLowerCase();
    if (!currencyTotals.has(currency)) {
      currencyTotals.set(currency, { startingMrrCents: 0, expansionMrrCents: 0, churnedMrrCents: 0, voluntaryCount: 0, involuntaryCount: 0 });
    }
    const totals = currencyTotals.get(currency)!;

    const startMrr = computeSubscriptionMonthlyMrrCents(subscription, period.start);
    totals.startingMrrCents += startMrr;

    const canceledAt = getCancellationTimestamp(subscription);
    if (!canceledAt || subscription.status !== "canceled") {
      continue;
    }

    const canceledAtMs = canceledAt * 1000;
    if (canceledAtMs < period.start.getTime() || canceledAtMs >= period.end.getTime()) {
      continue;
    }

    const churnType = classifyChurn(subscription, failedPayments.records);
    const churnMrrCents = computeSubscriptionMonthlyMrrCents(subscription, new Date(canceledAtMs - 1), {
      includeTrialing: false
    });
    const reasonLabel = getChurnReasonLabel(subscription, churnType);

    totals.churnedMrrCents += churnMrrCents;

    if (churnType === "involuntary") {
      totals.involuntaryCount += 1;
    } else {
      totals.voluntaryCount += 1;
    }

    const current = reasons.get(reasonLabel) ?? { count: 0, mrr_cents: 0 };
    current.count += 1;
    current.mrr_cents += churnMrrCents;
    reasons.set(reasonLabel, current);
  }

  for (const subscription of survivingSubscriptions) {
    const startMrr = computeSubscriptionMonthlyMrrCents(subscription, period.start);
    const endMrr = computeSubscriptionMonthlyMrrCents(subscription, periodEndPoint);

    if (subscription.created * 1000 < period.start.getTime() && endMrr > startMrr) {
      const currency = getSubscriptionCurrency(subscription).toLowerCase();
      if (!currencyTotals.has(currency)) {
        currencyTotals.set(currency, { startingMrrCents: 0, expansionMrrCents: 0, churnedMrrCents: 0, voluntaryCount: 0, involuntaryCount: 0 });
      }
      currencyTotals.get(currency)!.expansionMrrCents += endMrr - startMrr;
    }
  }

  function buildSummary(t: typeof currencyTotals extends Map<string, infer V> ? V : never, curr: string | null): GetChurnSummarySummary {
    return {
      churned_mrr_cents: t.churnedMrrCents,
      churned_mrr_formatted: curr ? formatMoney(t.churnedMrrCents, curr).formatted : "Multi-currency (see context)",
      gross_churn_rate_pct: calculateRate(t.churnedMrrCents, t.startingMrrCents),
      involuntary_count: t.involuntaryCount,
      net_churn_rate_pct: calculateRate(t.churnedMrrCents - t.expansionMrrCents, t.startingMrrCents),
      total_churned_count: t.voluntaryCount + t.involuntaryCount,
      voluntary_count: t.voluntaryCount
    };
  }

  let summary: GetChurnSummarySummary;
  const currencyBreakdown: Record<string, GetChurnSummarySummary> = {};

  if (currencyTotals.size === 0) {
    summary = buildSummary({ startingMrrCents: 0, expansionMrrCents: 0, churnedMrrCents: 0, voluntaryCount: 0, involuntaryCount: 0 }, "usd");
  } else if (currencyTotals.size === 1) {
    const [currency, totals] = Array.from(currencyTotals.entries())[0]!;
    summary = buildSummary(totals, currency);
  } else {
    const aggregate = { startingMrrCents: 0, expansionMrrCents: 0, churnedMrrCents: 0, voluntaryCount: 0, involuntaryCount: 0 };
    for (const [currency, totals] of currencyTotals.entries()) {
      currencyBreakdown[currency] = buildSummary(totals, currency);
      aggregate.voluntaryCount += totals.voluntaryCount;
      aggregate.involuntaryCount += totals.involuntaryCount;
      // Note: We don't sum MRR cents across currencies as it's mathematically incorrect.
    }
    summary = buildSummary(aggregate, null);
    summary.churned_mrr_formatted = "Mixed currencies (see context)";
    summary.churned_mrr_cents = 0;
  }

  const items = Array.from(reasons.entries())
    .map(([reason, value]) => ({
      count: value.count,
      mrr_cents: value.mrr_cents,
      reason
    }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return right.mrr_cents - left.mrr_cents;
    })
    .slice(0, 10);

  const caveats = [
    ...failedPayments.caveats,
    "Gross churn uses MRR that existed immediately before cancellation. Net churn offsets churned MRR with expansion MRR from subscriptions that remained active or past_due at the end of the period."
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
      truncated:
        activeSubscriptions.truncated ||
        pastDueSubscriptions.truncated ||
        canceledSubscriptions.truncated ||
        failedPayments.truncated
    },
    items,
    summary
  };
}

export const getChurnSummaryTool: Tool<FastMCPSessionAuth, typeof churnSummaryInputSchema> = {
  description: "Summarize churn volume, churn rates, and top cancellation reasons for the requested period.",
  name: "get_churn_summary",
  parameters: churnSummaryInputSchema,
  async execute(args) {
    return executeCachedTool("get_churn_summary", args, async () => loadChurnSummary(args));
  }
};
