import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { resolveSingleCustomer } from "../lib/customer_lookup.js";
import {
  buildCustomerTimeline,
  getCurrentSubscription,
  getCustomerCurrentPlan,
  getCustomerLifetimeValueCents,
  getCustomerMrrContributionCents,
  getCustomerPaymentMethodStatus,
  loadCustomerProfileData
} from "../lib/customer_profiles.js";
import { formatMoney } from "../lib/money.js";
import { executeCachedTool } from "../lib/tool_execution.js";
import type { ToolResult } from "../lib/types.js";
import { getStripeClientContext } from "../stripe/client.js";

const customerProfileInputSchema = z.object({
  customer: z
    .string()
    .min(1)
    .describe("Required Stripe customer ID, exact email address, or name.")
});

type CustomerProfileInput = z.infer<typeof customerProfileInputSchema>;

interface CustomerProfileSummary {
  current_plan: string | null;
  customer_id: string;
  customer_since_iso: string;
  email: string | null;
  ltv_cents: number;
  ltv_formatted: string;
  mrr_contribution_cents: number;
  name: string | null;
  subscription_status: string | null;
  tenure_days: number;
}

interface CustomerProfileContext {
  default_payment_method_last4: string | null;
  payment_method_status: string;
  stripe_mode: "live" | "test";
}

type CustomerProfileResult = ToolResult<CustomerProfileSummary, CustomerProfileContext, ReturnType<typeof buildCustomerTimeline>[number]>;

async function loadCustomerProfile(args: CustomerProfileInput): Promise<CustomerProfileResult> {
  const stripeClient = getStripeClientContext();
  const customer = await resolveSingleCustomer(args.customer);
  const profile = await loadCustomerProfileData(customer);
  const currentSubscription = getCurrentSubscription(profile.subscriptions);
  const ltvCents = getCustomerLifetimeValueCents(profile.charges);
  const mrrContributionCents = getCustomerMrrContributionCents(profile.subscriptions);
  const paymentMethodStatus = getCustomerPaymentMethodStatus(customer);
  const customerSince = new Date(customer.created * 1000);

  return {
    context: {
      default_payment_method_last4: paymentMethodStatus.default_payment_method_last4,
      payment_method_status: paymentMethodStatus.payment_method_status,
      stripe_mode: stripeClient.mode
    },
    items: buildCustomerTimeline(profile, 30),
    summary: {
      current_plan: getCustomerCurrentPlan(profile.subscriptions),
      customer_id: customer.id,
      customer_since_iso: customerSince.toISOString(),
      email: customer.email ?? null,
      ltv_cents: ltvCents,
      ltv_formatted: formatMoney(ltvCents, customer.currency ?? "usd").formatted,
      mrr_contribution_cents: mrrContributionCents,
      name: customer.name ?? null,
      subscription_status: currentSubscription?.status ?? null,
      tenure_days: Math.max(0, Math.floor((Date.now() - customerSince.getTime()) / (24 * 60 * 60 * 1000)))
    }
  };
}

export const getCustomerProfileTool: Tool<FastMCPSessionAuth, typeof customerProfileInputSchema> = {
  description: "Return the full founder-oriented summary for one customer, including LTV, current plan, payment status, and recent timeline.",
  name: "get_customer_profile",
  parameters: customerProfileInputSchema,
  async execute(args) {
    return executeCachedTool("get_customer_profile", args, async () => loadCustomerProfile(args));
  }
};
