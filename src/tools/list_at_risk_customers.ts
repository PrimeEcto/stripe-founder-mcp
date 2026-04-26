import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { computeSubscriptionMonthlyMrrCents, getSubscriptionCustomerId, getSubscriptionPlanLabel } from "../lib/billing.js";
import { normalizeDateRange } from "../lib/dates.js";
import { loadFailedPaymentRecords } from "../lib/failed_payments.js";
import { formatMoney } from "../lib/money.js";
import { hydrateSubscriptionProducts } from "../lib/stripe_products.js";
import { customerEmailFromExpandable } from "../lib/stripe_records.js";
import { executeCachedTool } from "../lib/tool_execution.js";
import type { ToolResult } from "../lib/types.js";
import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

const RISK_SIGNALS = ["multiple_failed_attempts", "past_due", "payment_failed"] as const;

const listAtRiskCustomersInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional maximum number of at-risk customer rows to return. Defaults to 25."),
  risk_signals: z
    .array(z.enum(RISK_SIGNALS))
    .optional()
    .describe("Optional risk signals to apply. Defaults to past_due, payment_failed, and multiple_failed_attempts.")
});

type ListAtRiskCustomersInput = z.infer<typeof listAtRiskCustomersInputSchema>;

interface ListAtRiskCustomersSummary {
  at_risk_count: number;
  total_mrr_at_risk_cents: number;
  total_mrr_at_risk_formatted: string;
}

interface ListAtRiskCustomersContext {
  caveats: string[];
  signals_applied: Array<(typeof RISK_SIGNALS)[number]>;
  stripe_mode: "live" | "test";
  truncated: boolean;
}

interface ListAtRiskCustomersItem {
  customer_id: string;
  email: string | null;
  last_payment_attempt_iso: string | null;
  mrr_cents: number;
  retry_remaining: number | null;
  risk_signal: (typeof RISK_SIGNALS)[number];
  signal_detail: string;
}

type ListAtRiskCustomersResult = ToolResult<
  ListAtRiskCustomersSummary,
  ListAtRiskCustomersContext,
  ListAtRiskCustomersItem
>;

function addCustomerValue(map: Map<string, number>, customerId: string, amount: number): void {
  map.set(customerId, (map.get(customerId) ?? 0) + amount);
}

function sortItems(items: ListAtRiskCustomersItem[]): ListAtRiskCustomersItem[] {
  return [...items].sort((left, right) => {
    if (right.mrr_cents !== left.mrr_cents) {
      return right.mrr_cents - left.mrr_cents;
    }

    return (right.last_payment_attempt_iso ?? "").localeCompare(left.last_payment_attempt_iso ?? "");
  });
}

async function loadAtRiskCustomers(args: ListAtRiskCustomersInput): Promise<ListAtRiskCustomersResult> {
  const stripeClient = getStripeClientContext();
  const limit = args.limit ?? 25;
  const selectedSignals = new Set(args.risk_signals ?? ["past_due", "payment_failed", "multiple_failed_attempts"]);
  const orderedSignals = RISK_SIGNALS.filter((signal) => selectedSignals.has(signal));
  const failureWindow = normalizeDateRange("last_30_days");

  const [activeSubscriptions, pastDueSubscriptions, failedPayments] = await Promise.all([
    stripeClient.getCachedToolResult("list_at_risk_customers:active_subscriptions", {}, async () =>
      collectAutoPaged(
        stripeClient.stripe.subscriptions.list({
          expand: ["data.customer", "data.items.data.price"],
          limit: 100,
          status: "active"
        }),
        stripeClient.maxListResults
      )
    ),
    stripeClient.getCachedToolResult("list_at_risk_customers:past_due_subscriptions", {}, async () =>
      collectAutoPaged(
        stripeClient.stripe.subscriptions.list({
          expand: ["data.customer", "data.items.data.price", "data.latest_invoice.payment_intent"],
          limit: 100,
          status: "past_due"
        }),
        stripeClient.maxListResults
      )
    ),
    loadFailedPaymentRecords(failureWindow, "list_at_risk_customers:failed_payments")
  ]);
  const subscriptions = await hydrateSubscriptionProducts(
    [...activeSubscriptions.items, ...pastDueSubscriptions.items],
    "list_at_risk_customers:subscription_products"
  );

  const now = new Date();
  const customerMrr = new Map<string, number>();
  const customerEmails = new Map<string, string | null>();
  const latestFailedPaymentByCustomer = new Map<string, Awaited<ReturnType<typeof loadFailedPaymentRecords>>["records"][number]>();
  const failedPaymentCountsByCustomer = new Map<string, number>();

  for (const record of failedPayments.records) {
    if (!record.customer_id) {
      continue;
    }

    if (!latestFailedPaymentByCustomer.has(record.customer_id)) {
      latestFailedPaymentByCustomer.set(record.customer_id, record);
    }

    failedPaymentCountsByCustomer.set(record.customer_id, (failedPaymentCountsByCustomer.get(record.customer_id) ?? 0) + 1);

    if (!customerEmails.has(record.customer_id)) {
      customerEmails.set(record.customer_id, record.customer_email);
    }
  }

  const items: ListAtRiskCustomersItem[] = [];
  for (const subscription of subscriptions) {
    const customerId = getSubscriptionCustomerId(subscription);
    if (!customerId) {
      continue;
    }

    const email = customerEmailFromExpandable(subscription.customer);
    const mrrCents = computeSubscriptionMonthlyMrrCents(subscription, now);

    addCustomerValue(customerMrr, customerId, mrrCents);

    if (!customerEmails.has(customerId)) {
      customerEmails.set(customerId, email);
    }

    if (!selectedSignals.has("past_due") || subscription.status !== "past_due") {
      continue;
    }

    const latestFailure = latestFailedPaymentByCustomer.get(customerId);

    items.push({
      customer_id: customerId,
      email,
      last_payment_attempt_iso: latestFailure?.attempted_at_iso ?? null,
      mrr_cents: mrrCents,
      retry_remaining: latestFailure?.current_state === "final_failure" ? 0 : null,
      risk_signal: "past_due",
      signal_detail: `Subscription ${subscription.id} is currently past_due on ${getSubscriptionPlanLabel(subscription)}.`
    });
  }

  if (selectedSignals.has("payment_failed")) {
    for (const [customerId, record] of latestFailedPaymentByCustomer.entries()) {
      if (record.current_state === "recovered") {
        continue;
      }

      items.push({
        customer_id: customerId,
        email: customerEmails.get(customerId) ?? record.customer_email,
        last_payment_attempt_iso: record.attempted_at_iso,
        mrr_cents: customerMrr.get(customerId) ?? 0,
        retry_remaining: record.current_state === "final_failure" ? 0 : null,
        risk_signal: "payment_failed",
        signal_detail:
          record.current_state === "retrying"
            ? `Latest payment failure is still retrying${record.failure_code ? ` (${record.failure_code})` : ""}.`
            : `Latest payment failure is unrecovered${record.failure_code ? ` (${record.failure_code})` : ""}.`
      });
    }
  }

  if (selectedSignals.has("multiple_failed_attempts")) {
    for (const [customerId, count] of failedPaymentCountsByCustomer.entries()) {
      if (count < 2) {
        continue;
      }

      const latestFailure = latestFailedPaymentByCustomer.get(customerId);
      if (!latestFailure || latestFailure.current_state === "recovered") {
        continue;
      }

      items.push({
        customer_id: customerId,
        email: customerEmails.get(customerId) ?? latestFailure.customer_email,
        last_payment_attempt_iso: latestFailure.attempted_at_iso,
        mrr_cents: customerMrr.get(customerId) ?? 0,
        retry_remaining: latestFailure.current_state === "final_failure" ? 0 : null,
        risk_signal: "multiple_failed_attempts",
        signal_detail: `${count} failed payment attempts were recorded in ${failureWindow.label.toLowerCase()}.`
      });
    }
  }

  const sortedItems = sortItems(items).slice(0, limit);
  const uniqueCustomerIds = new Set(sortedItems.map((item) => item.customer_id));
  let totalMrrAtRiskCents = 0;
  for (const customerId of uniqueCustomerIds) {
    totalMrrAtRiskCents += customerMrr.get(customerId) ?? 0;
  }

  return {
    context: {
      caveats: [
        ...failedPayments.caveats,
        "MRR at risk includes only active and past_due subscriptions. retry_remaining is null when Stripe does not expose the remaining retry count."
      ],
      signals_applied: orderedSignals,
      stripe_mode: stripeClient.mode,
      truncated:
        activeSubscriptions.truncated || pastDueSubscriptions.truncated || failedPayments.truncated || items.length > limit
    },
    items: sortedItems,
    summary: {
      at_risk_count: uniqueCustomerIds.size,
      total_mrr_at_risk_cents: totalMrrAtRiskCents,
      total_mrr_at_risk_formatted: formatMoney(totalMrrAtRiskCents, "usd").formatted
    }
  };
}

export const listAtRiskCustomersTool: Tool<FastMCPSessionAuth, typeof listAtRiskCustomersInputSchema> = {
  description: "Show customers most at risk of churn because of past-due subscriptions or repeated failed payments.",
  name: "list_at_risk_customers",
  parameters: listAtRiskCustomersInputSchema,
  async execute(args) {
    return executeCachedTool("list_at_risk_customers", args, async () => loadAtRiskCustomers(args));
  }
};
