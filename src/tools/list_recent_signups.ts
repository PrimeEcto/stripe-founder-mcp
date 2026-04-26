import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { normalizeDateRange } from "../lib/dates.js";
import { formatMoney } from "../lib/money.js";
import { getCustomerCurrentPlan, getCustomerMrrContributionCents } from "../lib/customer_profiles.js";
import { hydrateSubscriptionProducts } from "../lib/stripe_products.js";
import { getDefaultPaymentMethod } from "../lib/stripe_records.js";
import { executeCachedTool } from "../lib/tool_execution.js";
import type { ToolResult } from "../lib/types.js";
import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

const listRecentSignupsInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional maximum number of recent signups to return. Defaults to 50."),
  min_mrr_cents: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Optional minimum current MRR filter, in cents. Customers below this threshold are excluded from the returned signup list."),
  period: z
    .union([
      z.string(),
      z.object({
        end: z.string().describe("ISO 8601 UTC end timestamp for the signup window."),
        start: z.string().describe("ISO 8601 UTC start timestamp for the signup window.")
      })
    ])
    .optional()
    .describe("Optional signup window. Defaults to last_7_days and accepts ISO ranges, last_30_days, 2026-Q1, or March 2026.")
});

type ListRecentSignupsInput = z.infer<typeof listRecentSignupsInputSchema>;

interface ListRecentSignupsSummary {
  paid_signup_count: number;
  signup_count: number;
  total_new_mrr_cents: number;
  total_new_mrr_formatted: string;
}

interface ListRecentSignupsContext {
  caveats: string[];
  minimum_mrr_cents: number | null;
  period_label: string;
  stripe_mode: "live" | "test";
  truncated: boolean;
}

interface ListRecentSignupsItem {
  current_plan: string | null;
  currency: string | null;
  customer_id: string;
  email: string | null;
  mrr_cents: number;
  name: string | null;
  payment_method_attached: boolean;
  signed_up_iso: string;
}

type ListRecentSignupsResult = ToolResult<ListRecentSignupsSummary, ListRecentSignupsContext, ListRecentSignupsItem>;

async function loadRecentSignups(args: ListRecentSignupsInput): Promise<ListRecentSignupsResult> {
  const stripeClient = getStripeClientContext();
  const period = normalizeDateRange(args.period, new Date(), "last_7_days");
  const limit = args.limit ?? 50;
  const minimumMrrCents = args.min_mrr_cents ?? null;

  const customers = await stripeClient.getCachedToolResult("list_recent_signups:customers", args, async () =>
    collectAutoPaged(
      stripeClient.stripe.customers.list({
        created: {
          gte: Math.floor(period.start.getTime() / 1000),
          lt: Math.floor(period.end.getTime() / 1000)
        },
        expand: ["data.invoice_settings.default_payment_method"],
        limit: 100
      }),
      stripeClient.maxListResults
    )
  );

  let truncated = customers.truncated;
  const customerProfiles: Array<{
    current_plan: string | null;
    customer: typeof customers.items[number];
    mrr_cents: number;
  }> = [];
  for (const customer of customers.items) {
    const subscriptions = await stripeClient.getCachedToolResult(
      `list_recent_signups:subscriptions:${customer.id}`,
      {},
      async () =>
        collectAutoPaged(
          stripeClient.stripe.subscriptions.list({
            customer: customer.id,
            expand: ["data.items.data.price"],
            limit: 100,
            status: "all"
          }),
          100
        )
    );

    if (subscriptions.truncated) {
      truncated = true;
    }

    const hydratedSubscriptions = await hydrateSubscriptionProducts(
      subscriptions.items,
      `list_recent_signups:subscription_products:${customer.id}`
    );
    const mrrCents = getCustomerMrrContributionCents(hydratedSubscriptions);

    customerProfiles.push({
      current_plan: getCustomerCurrentPlan(hydratedSubscriptions),
      customer,
      mrr_cents: mrrCents
    });
  }

  const filtered = customerProfiles
    .filter((entry) => minimumMrrCents === null || entry.mrr_cents >= minimumMrrCents)
    .sort((left, right) => right.customer.created - left.customer.created);

  const items = filtered.slice(0, limit).map((entry) => ({
    current_plan: entry.current_plan,
    currency: entry.customer.currency ?? null,
    customer_id: entry.customer.id,
    email: entry.customer.email ?? null,
    mrr_cents: entry.mrr_cents,
    name: entry.customer.name ?? null,
    payment_method_attached: getDefaultPaymentMethod(entry.customer) !== null,
    signed_up_iso: new Date(entry.customer.created * 1000).toISOString()
  }));

  const paidSignupCount = items.filter((item) => item.mrr_cents > 0).length;
  const paidCurrencies = new Set(items.filter((i) => i.mrr_cents > 0).map((i) => i.currency ?? "usd"));
  const totalNewMrrCents = paidCurrencies.size <= 1 ? items.reduce((total, item) => total + item.mrr_cents, 0) : 0;
  const totalNewMrrFormatted =
    paidCurrencies.size <= 1
      ? formatMoney(totalNewMrrCents, Array.from(paidCurrencies)[0] ?? "usd").formatted
      : "Mixed currencies";

  return {
    context: {
      caveats: ["MRR includes only active and past_due subscriptions. Trialing signups are surfaced with mrr_cents = 0."],
      minimum_mrr_cents: minimumMrrCents,
      period_label: period.label,
      stripe_mode: stripeClient.mode,
      truncated: truncated || filtered.length > limit
    },
    items,
    summary: {
      paid_signup_count: paidSignupCount,
      signup_count: items.length,
      total_new_mrr_cents: totalNewMrrCents,
      total_new_mrr_formatted: totalNewMrrFormatted
    }
  };
}

export const listRecentSignupsTool: Tool<FastMCPSessionAuth, typeof listRecentSignupsInputSchema> = {
  description: "List recently created customers, highlighting which signups already contribute paid MRR.",
  name: "list_recent_signups",
  parameters: listRecentSignupsInputSchema,
  async execute(args) {
    return executeCachedTool("list_recent_signups", args, async () => loadRecentSignups(args));
  }
};
