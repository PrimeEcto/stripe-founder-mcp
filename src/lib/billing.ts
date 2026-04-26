import type Stripe from "stripe";

const MRR_ELIGIBLE_STATUSES = new Set<Stripe.Subscription.Status>(["active", "past_due"]);

function getQuantity(item: Stripe.SubscriptionItem): number {
  return item.quantity ?? 1;
}

function getRecurringMonthlyAmount(unitAmount: number, recurring: Stripe.Price.Recurring): number {
  const intervalCount = recurring.interval_count ?? 1;

  if (recurring.interval === "month") {
    return unitAmount / intervalCount;
  }

  if (recurring.interval === "year") {
    return unitAmount / (12 * intervalCount);
  }

  if (recurring.interval === "week") {
    return (unitAmount * 52) / (12 * intervalCount);
  }

  return (unitAmount * 365) / (12 * intervalCount);
}

export function getSubscriptionCurrency(subscription: Stripe.Subscription): string {
  return subscription.currency ?? subscription.items.data[0]?.price.currency ?? "usd";
}

export function getSubscriptionCustomerId(subscription: Stripe.Subscription): string | undefined {
  return typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
}

export function getSubscriptionPlanLabel(subscription: Stripe.Subscription): string {
  const primaryItem = subscription.items.data[0];
  if (!primaryItem) {
    return "Unknown plan";
  }

  const price = primaryItem.price;
  if (price.nickname) {
    return price.nickname;
  }

  const product = price.product;
  if (typeof product !== "string" && !("deleted" in product && product.deleted) && product.name) {
    return product.name;
  }

  return `Price ID: ${price.id}`;
}

export function getSubscriptionStatusAtPoint(
  subscription: Stripe.Subscription,
  asOf: Date
): Stripe.Subscription.Status | "not_started" {
  const asOfMs = asOf.getTime();

  if (subscription.created * 1000 > asOfMs) {
    return "not_started";
  }

  if (subscription.canceled_at && subscription.canceled_at * 1000 <= asOfMs) {
    return "canceled";
  }

  if (subscription.ended_at && subscription.ended_at * 1000 <= asOfMs) {
    return "canceled";
  }

  if (subscription.trial_end && subscription.trial_end * 1000 > asOfMs) {
    return "trialing";
  }

  if (subscription.status === "canceled") {
    return "active";
  }

  return subscription.status;
}

export function isMrrEligibleStatus(status: Stripe.Subscription.Status | "not_started"): boolean {
  return MRR_ELIGIBLE_STATUSES.has(status as Stripe.Subscription.Status);
}

export function computeSubscriptionMonthlyMrrCents(
  subscription: Stripe.Subscription,
  asOf: Date,
  options: {
    includeTrialing?: boolean;
  } = {}
): number {
  const status = getSubscriptionStatusAtPoint(subscription, asOf);

  if (status === "trialing" && !options.includeTrialing) {
    return 0;
  }

  if (!isMrrEligibleStatus(status) && !(options.includeTrialing && status === "trialing")) {
    return 0;
  }

  let total = 0;
  for (const item of subscription.items.data) {
    const recurring = item.price.recurring;
    const unitAmount = item.price.unit_amount;

    if (!recurring || unitAmount === null) {
      continue;
    }

    total += Math.round(getRecurringMonthlyAmount(unitAmount, recurring) * getQuantity(item));
  }

  return total;
}

export function computeTrialPotentialMrrCents(subscription: Stripe.Subscription, asOf: Date): number {
  return getSubscriptionStatusAtPoint(subscription, asOf) === "trialing"
    ? computeSubscriptionMonthlyMrrCents(subscription, asOf, { includeTrialing: true })
    : 0;
}
