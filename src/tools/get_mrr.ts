import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { computeSubscriptionMonthlyMrrCents, computeTrialPotentialMrrCents, getSubscriptionStatusAtPoint } from "../lib/billing.js";
import { normalizeDatePoint } from "../lib/dates.js";
import { formatMoney } from "../lib/money.js";
import { executeCachedTool } from "../lib/tool_execution.js";
import type { ToolResult } from "../lib/types.js";
import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

const getMrrInputSchema = z.object({
  as_of: z
    .string()
    .optional()
    .describe("Optional ISO date or relative date string. Defaults to now. Examples: 2026-04-26, last_30_days, March 2026."),
  compare_to: z
    .string()
    .optional()
    .describe("Optional comparison date or period. Defaults to last_month. Examples: last_month, 2026-Q1, 30_days_ago.")
});

type GetMrrInput = z.infer<typeof getMrrInputSchema>;

interface GetMrrSummary {
  active_subscriptions_count: number;
  currency: string;
  delta_pct: number;
  delta_vs_compare_cents: number;
  mrr_cents: number;
  mrr_formatted: string;
}

interface GetMrrContext {
  as_of_iso: string;
  caveats: string[];
  compare_period_label: string;
  potential_mrr_from_trials_cents: number;
  potential_mrr_from_trials_formatted: string;
  stripe_mode: "live" | "test";
  trialing_subscriptions_count: number;
  truncated: boolean;
}

interface GetMrrItem {
  compare_mrr_cents: number;
  compare_mrr_formatted: string;
  currency: string;
  delta_pct: number;
  delta_vs_compare_cents: number;
  mrr_cents: number;
  mrr_formatted: string;
}

type GetMrrResult = ToolResult<GetMrrSummary, GetMrrContext, GetMrrItem>;

function calculateDeltaPct(currentValue: number, compareValue: number): number {
  if (compareValue === 0) {
    return currentValue === 0 ? 0 : 100;
  }

  return Number((((currentValue - compareValue) / compareValue) * 100).toFixed(2));
}

function getCurrencyTotals(resultByCurrency: Map<string, number>, currency: string): number {
  return resultByCurrency.get(currency) ?? 0;
}

function buildSingleCurrencyResult(
  currency: string,
  currentMrrCents: number,
  compareMrrCents: number,
  trialingCount: number,
  activeSubscriptionCount: number,
  trialPotentialCents: number,
  stripeMode: "live" | "test",
  compareLabel: string,
  asOfIso: string,
  truncated: boolean
): GetMrrResult {
  const currentMoney = formatMoney(currentMrrCents, currency);
  const trialMoney = formatMoney(trialPotentialCents, currency);
  const deltaCents = currentMrrCents - compareMrrCents;

  return {
    context: {
      as_of_iso: asOfIso,
      caveats: [
        "MRR includes only subscriptions in active or past_due status; trialing subscriptions are excluded from headline MRR."
      ],
      compare_period_label: compareLabel,
      potential_mrr_from_trials_cents: trialMoney.amount_cents,
      potential_mrr_from_trials_formatted: trialMoney.formatted,
      stripe_mode: stripeMode,
      trialing_subscriptions_count: trialingCount,
      truncated
    },
    items: [],
    summary: {
      active_subscriptions_count: activeSubscriptionCount,
      currency,
      delta_pct: calculateDeltaPct(currentMrrCents, compareMrrCents),
      delta_vs_compare_cents: deltaCents,
      mrr_cents: currentMoney.amount_cents,
      mrr_formatted: currentMoney.formatted
    }
  };
}

async function loadGetMrr(args: GetMrrInput): Promise<GetMrrResult> {
  const stripeClient = getStripeClientContext();
  const asOf = normalizeDatePoint(args.as_of, new Date(), new Date().toISOString());
  const compareTo = normalizeDatePoint(args.compare_to, new Date(), "last_month");

  const subscriptions = await stripeClient.getCachedToolResult("get_mrr:subscriptions", { maxListResults: stripeClient.maxListResults }, async () =>
    collectAutoPaged(
      stripeClient.stripe.subscriptions.list({
        expand: ["data.items.data.price"],
        status: "all"
      }),
      stripeClient.maxListResults
    )
  );

  const currentMrrByCurrency = new Map<string, number>();
  const compareMrrByCurrency = new Map<string, number>();
  const trialPotentialByCurrency = new Map<string, number>();
  let activeSubscriptionCount = 0;
  let trialingSubscriptionCount = 0;

  for (const subscription of subscriptions.items) {
    const currency = subscription.currency ?? "usd";
    const currentStatus = getSubscriptionStatusAtPoint(subscription, asOf.value);

    if (currentStatus === "active") {
      activeSubscriptionCount += 1;
    }

    if (currentStatus === "trialing") {
      trialingSubscriptionCount += 1;
    }

    currentMrrByCurrency.set(
      currency,
      getCurrencyTotals(currentMrrByCurrency, currency) + computeSubscriptionMonthlyMrrCents(subscription, asOf.value)
    );
    compareMrrByCurrency.set(
      currency,
      getCurrencyTotals(compareMrrByCurrency, currency) + computeSubscriptionMonthlyMrrCents(subscription, compareTo.value)
    );
    trialPotentialByCurrency.set(
      currency,
      getCurrencyTotals(trialPotentialByCurrency, currency) + computeTrialPotentialMrrCents(subscription, asOf.value)
    );
  }

  const currencies = Array.from(
    new Set([...currentMrrByCurrency.keys(), ...compareMrrByCurrency.keys(), ...trialPotentialByCurrency.keys()])
  );

  if (currencies.length <= 1) {
    const currency = currencies[0] ?? "usd";
    return buildSingleCurrencyResult(
      currency,
      getCurrencyTotals(currentMrrByCurrency, currency),
      getCurrencyTotals(compareMrrByCurrency, currency),
      trialingSubscriptionCount,
      activeSubscriptionCount,
      getCurrencyTotals(trialPotentialByCurrency, currency),
      stripeClient.mode,
      compareTo.label,
      asOf.iso,
      subscriptions.truncated
    );
  }

  const items: GetMrrItem[] = currencies.map((currency) => {
    const currentMrrCents = getCurrencyTotals(currentMrrByCurrency, currency);
    const compareMrrCents = getCurrencyTotals(compareMrrByCurrency, currency);
    const deltaCents = currentMrrCents - compareMrrCents;

    return {
      compare_mrr_cents: compareMrrCents,
      compare_mrr_formatted: formatMoney(compareMrrCents, currency).formatted,
      currency,
      delta_pct: calculateDeltaPct(currentMrrCents, compareMrrCents),
      delta_vs_compare_cents: deltaCents,
      mrr_cents: currentMrrCents,
      mrr_formatted: formatMoney(currentMrrCents, currency).formatted
    };
  });

  return {
    context: {
      as_of_iso: asOf.iso,
      caveats: [
        "MRR includes only subscriptions in active or past_due status; trialing subscriptions are excluded from headline MRR.",
        "Multiple currencies were detected, so headline totals are omitted rather than FX-converted."
      ],
      compare_period_label: compareTo.label,
      potential_mrr_from_trials_cents: 0,
      potential_mrr_from_trials_formatted: "Mixed currencies",
      stripe_mode: stripeClient.mode,
      trialing_subscriptions_count: trialingSubscriptionCount,
      truncated: subscriptions.truncated
    },
    items,
    summary: {
      active_subscriptions_count: activeSubscriptionCount,
      currency: "mixed",
      delta_pct: 0,
      delta_vs_compare_cents: 0,
      mrr_cents: 0,
      mrr_formatted: "Mixed currencies"
    }
  };
}

export const getMrrTool: Tool<FastMCPSessionAuth, typeof getMrrInputSchema> = {
  description: "Answer the founder question 'What is my MRR right now?' with current MRR, comparison delta, and trial potential.",
  name: "get_mrr",
  parameters: getMrrInputSchema,
  async execute(args) {
    return executeCachedTool("get_mrr", args, async () => loadGetMrr(args));
  }
};
