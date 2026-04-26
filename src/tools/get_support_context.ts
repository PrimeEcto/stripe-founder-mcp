import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { resolveSingleCustomer } from "../lib/customer_lookup.js";
import {
  buildCustomerTimeline,
  getCurrentSubscription,
  getCustomerLifetimeValueCents,
  getCustomerMrrContributionCents,
  getCustomerPaymentMethodStatus,
  loadCustomerProfileData
} from "../lib/customer_profiles.js";
import { executeCachedTool } from "../lib/tool_execution.js";
import type { ToolResult } from "../lib/types.js";
import { getStripeClientContext } from "../stripe/client.js";

const supportContextInputSchema = z.object({
  context_hint: z
    .string()
    .optional()
    .describe("Optional free-text note from the support ticket. Keywords such as refund, dispute, invoice, or trial bias which events appear first."),
  customer: z
    .string()
    .min(1)
    .describe("Required Stripe customer ID, exact email address, or name.")
});

type SupportContextInput = z.infer<typeof supportContextInputSchema>;

interface SupportContextSummary {
  customer_id: string;
  email: string | null;
  flags: string[];
  mrr_contribution_cents: number;
  name: string | null;
  subscription_status: string | null;
}

interface SupportContextContext {
  default_payment_method_last4: string | null;
  payment_method_status: string;
  refund_eligible_charges: Array<{ amount_cents: number; charge_id: string; paid_at_iso: string }>;
  stripe_mode: "live" | "test";
}

type SupportContextResult = ToolResult<SupportContextSummary, SupportContextContext, ReturnType<typeof buildCustomerTimeline>[number]>;

function buildSupportFlags(profile: Awaited<ReturnType<typeof loadCustomerProfileData>>, ltvCents: number): string[] {
  const flags = new Set<string>();
  const currentSubscription = getCurrentSubscription(profile.subscriptions);

  if (currentSubscription?.status === "past_due") {
    flags.add("in_dunning");
  }

  if (profile.charges.some((charge) => charge.disputed)) {
    flags.add("recent_dispute");
  }

  if (currentSubscription?.status === "trialing" && currentSubscription.trial_end) {
    const daysUntilTrialEnd = (currentSubscription.trial_end * 1000 - Date.now()) / (24 * 60 * 60 * 1000);
    if (daysUntilTrialEnd <= 7) {
      flags.add("trial_ending_soon");
    }
  }

  if (ltvCents >= 10_000) {
    flags.add("high_value");
  }

  if ((Date.now() - profile.customer.created * 1000) / (24 * 60 * 60 * 1000) <= 30) {
    flags.add("new_customer");
  }

  return Array.from(flags);
}

function prioritizeSupportTimeline(
  items: ReturnType<typeof buildCustomerTimeline>,
  contextHint: string | undefined
): ReturnType<typeof buildCustomerTimeline> {
  if (!contextHint) {
    return items;
  }

  const hint = contextHint.toLowerCase();
  const prioritizedTypes = hint.includes("refund")
    ? new Set(["charge", "invoice"])
    : hint.includes("billing") || hint.includes("payment")
      ? new Set(["charge", "invoice"])
      : hint.includes("cancel") || hint.includes("churn")
        ? new Set(["subscription_created", "subscription_canceled"])
        : hint.includes("dispute")
          ? new Set(["charge"])
          : hint.includes("trial")
            ? new Set(["subscription_created", "subscription_canceled"])
            : new Set<string>();

  return [...items].sort((left, right) => {
    const leftPriority = prioritizedTypes.has(left.type) ? 0 : 1;
    const rightPriority = prioritizedTypes.has(right.type) ? 0 : 1;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return right.occurred_at_iso.localeCompare(left.occurred_at_iso);
  });
}

async function loadSupportContext(args: SupportContextInput): Promise<SupportContextResult> {
  const stripeClient = getStripeClientContext();
  const customer = await resolveSingleCustomer(args.customer);
  const profile = await loadCustomerProfileData(customer);
  const currentSubscription = getCurrentSubscription(profile.subscriptions);
  const ltvCents = getCustomerLifetimeValueCents(profile.charges);
  const mrrContributionCents = getCustomerMrrContributionCents(profile.subscriptions);
  const paymentMethodStatus = getCustomerPaymentMethodStatus(customer);
  const recentRefundEligibleCharges = profile.charges
    .filter((charge) => charge.status === "succeeded" && Date.now() - charge.created * 1000 <= 60 * 24 * 60 * 60 * 1000)
    .slice(0, 10)
    .map((charge) => ({
      amount_cents: charge.amount,
      charge_id: charge.id,
      paid_at_iso: new Date(charge.created * 1000).toISOString()
    }));

  return {
    context: {
      default_payment_method_last4: paymentMethodStatus.default_payment_method_last4,
      payment_method_status: paymentMethodStatus.payment_method_status,
      refund_eligible_charges: recentRefundEligibleCharges,
      stripe_mode: stripeClient.mode
    },
    items: prioritizeSupportTimeline(buildCustomerTimeline(profile, 30), args.context_hint),
    summary: {
      customer_id: customer.id,
      email: customer.email ?? null,
      flags: buildSupportFlags(profile, ltvCents),
      mrr_contribution_cents: mrrContributionCents,
      name: customer.name ?? null,
      subscription_status: currentSubscription?.status ?? null
    }
  };
}

export const getSupportContextTool: Tool<FastMCPSessionAuth, typeof supportContextInputSchema> = {
  description: "Summarize everything support needs for a customer, with risk flags and a timeline prioritized by the ticket context.",
  name: "get_support_context",
  parameters: supportContextInputSchema,
  async execute(args) {
    return executeCachedTool("get_support_context", args, async () => loadSupportContext(args));
  }
};
