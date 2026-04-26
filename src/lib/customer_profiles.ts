import type Stripe from "stripe";

import { computeSubscriptionMonthlyMrrCents, getSubscriptionPlanLabel } from "./billing.js";
import { hydrateSubscriptionProducts } from "./stripe_products.js";
import { createdToIso, getDefaultPaymentMethod, getPaymentMethodLast4 } from "./stripe_records.js";
import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

export interface CustomerTimelineItem {
  amount_cents?: number;
  description: string;
  occurred_at_iso: string;
  status: string;
  type: string;
}

export interface CustomerProfileData {
  charges: Stripe.Charge[];
  customer: Stripe.Customer;
  invoices: Stripe.Invoice[];
  subscriptions: Stripe.Subscription[];
}

function sortByCreatedDescending<T extends { created: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.created - left.created);
}

export async function loadCustomerProfileData(customer: Stripe.Customer): Promise<CustomerProfileData> {
  const stripeClient = getStripeClientContext();

  const [charges, invoices, subscriptions] = await Promise.all([
    stripeClient.getCachedToolResult(`customer_profile:charges:${customer.id}`, {}, async () =>
      collectAutoPaged(
        stripeClient.stripe.charges.list({
          customer: customer.id,
          expand: ["data.customer"],
          limit: 100
        }),
        100
      )
    ),
    stripeClient.getCachedToolResult(`customer_profile:invoices:${customer.id}`, {}, async () =>
      collectAutoPaged(
        stripeClient.stripe.invoices.list({
          customer: customer.id,
          expand: ["data.payment_intent"],
          limit: 100
        }),
        100
      )
    ),
    stripeClient.getCachedToolResult(`customer_profile:subscriptions:${customer.id}`, {}, async () =>
      collectAutoPaged(
        stripeClient.stripe.subscriptions.list({
          customer: customer.id,
          expand: ["data.items.data.price"],
          limit: 100,
          status: "all"
        }),
        100
      )
    )
  ]);
  const hydratedSubscriptions = await hydrateSubscriptionProducts(
    subscriptions.items,
    `customer_profile:subscription_products:${customer.id}`
  );

  return {
    charges: sortByCreatedDescending(charges.items),
    customer,
    invoices: sortByCreatedDescending(invoices.items),
    subscriptions: sortByCreatedDescending(hydratedSubscriptions)
  };
}

export function getCustomerLifetimeValueCents(charges: Stripe.Charge[]): number {
  return charges
    .filter((charge) => charge.status === "succeeded")
    .reduce((total, charge) => total + (charge.amount - charge.amount_refunded), 0);
}

export function getCurrentSubscription(subscriptions: Stripe.Subscription[]): Stripe.Subscription | undefined {
  return subscriptions.find((subscription) => ["active", "past_due", "trialing"].includes(subscription.status));
}

export function getCustomerMrrContributionCents(subscriptions: Stripe.Subscription[]): number {
  const now = new Date();
  return subscriptions.reduce((total, subscription) => total + computeSubscriptionMonthlyMrrCents(subscription, now), 0);
}

export function getCustomerCurrentPlan(subscriptions: Stripe.Subscription[]): string | null {
  const currentSubscription = getCurrentSubscription(subscriptions);
  return currentSubscription ? getSubscriptionPlanLabel(currentSubscription) : null;
}

export function getCustomerPaymentMethodStatus(
  customer: Stripe.Customer
): { default_payment_method_last4: string | null; payment_method_status: string } {
  const paymentMethod = getDefaultPaymentMethod(customer);

  if (!paymentMethod) {
    return {
      default_payment_method_last4: null,
      payment_method_status: "missing"
    };
  }

  return {
    default_payment_method_last4: getPaymentMethodLast4(customer),
    payment_method_status: paymentMethod.type
  };
}

export function buildCustomerTimeline(profile: CustomerProfileData, limit = 30): CustomerTimelineItem[] {
  const items: CustomerTimelineItem[] = [];

  for (const charge of profile.charges.slice(0, limit)) {
    const iso = createdToIso(charge.created);
    if (!iso) {
      continue;
    }

    items.push({
      amount_cents: charge.amount,
      description: charge.description ?? charge.statement_descriptor ?? "Charge",
      occurred_at_iso: iso,
      status: charge.status,
      type: "charge"
    });
  }

  for (const invoice of profile.invoices.slice(0, limit)) {
    const iso = createdToIso(invoice.created);
    if (!iso) {
      continue;
    }

    items.push({
      amount_cents: invoice.amount_paid || invoice.total,
      description: invoice.description ?? invoice.number ?? "Invoice",
      occurred_at_iso: iso,
      status: invoice.status ?? "unknown",
      type: "invoice"
    });
  }

  for (const subscription of profile.subscriptions.slice(0, limit)) {
    const createdIso = createdToIso(subscription.created);
    if (createdIso) {
      items.push({
        description: `Subscription created for ${getSubscriptionPlanLabel(subscription)}`,
        occurred_at_iso: createdIso,
        status: subscription.status,
        type: "subscription_created"
      });
    }

    const canceledIso = createdToIso(subscription.canceled_at ?? subscription.ended_at ?? undefined);
    if (canceledIso) {
      items.push({
        description: `Subscription canceled for ${getSubscriptionPlanLabel(subscription)}`,
        occurred_at_iso: canceledIso,
        status: subscription.status,
        type: "subscription_canceled"
      });
    }
  }

  return items
    .sort((left, right) => right.occurred_at_iso.localeCompare(left.occurred_at_iso))
    .slice(0, limit);
}
