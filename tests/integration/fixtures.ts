import "dotenv/config";

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import Stripe from "stripe";

const FIXTURE_NAMESPACE = "stripe-founder-mcp-v1";
const CUSTOMER_EMAILS = {
  activeAnnual: `fixture+active-annual.${FIXTURE_NAMESPACE}@example.com`,
  activeBasic: `fixture+active-basic.${FIXTURE_NAMESPACE}@example.com`,
  activePro: `fixture+active-pro.${FIXTURE_NAMESPACE}@example.com`,
  pastDue: `fixture+past-due.${FIXTURE_NAMESPACE}@example.com`,
  trialing: `fixture+trialing.${FIXTURE_NAMESPACE}@example.com`
} as const;

const PRICE_KEYS = {
  annual: `${FIXTURE_NAMESPACE}_annual`,
  basic: `${FIXTURE_NAMESPACE}_basic`,
  pro: `${FIXTURE_NAMESPACE}_pro`,
  trial: `${FIXTURE_NAMESPACE}_trial`,
  risk: `${FIXTURE_NAMESPACE}_risk`
} as const;

const RESOURCE_KEYS = {
  activeAnnual: `${FIXTURE_NAMESPACE}_active_annual_subscription`,
  activeBasic: `${FIXTURE_NAMESPACE}_active_basic_subscription`,
  activePro: `${FIXTURE_NAMESPACE}_active_pro_subscription`,
  canceledFeedback: `${FIXTURE_NAMESPACE}_canceled_feedback_subscription`,
  disputedCharge: `${FIXTURE_NAMESPACE}_disputed_charge`,
  failedRecoveredInvoice: `${FIXTURE_NAMESPACE}_failed_recovered_invoice`,
  pastDueSubscription: `${FIXTURE_NAMESPACE}_past_due_subscription`,
  successfulCharge: `${FIXTURE_NAMESPACE}_successful_charge`,
  trialingSubscription: `${FIXTURE_NAMESPACE}_trialing_subscription`
} as const;

const SUBSCRIPTION_EXPAND = ["data.customer", "data.items.data.price", "data.latest_invoice.payment_intent"] as const;

export interface IntegrationFixture {
  canceled_subscription: Stripe.Subscription;
  customers: {
    activeAnnual: Stripe.Customer;
    activeBasic: Stripe.Customer;
    activePro: Stripe.Customer;
    pastDue: Stripe.Customer;
    trialing: Stripe.Customer;
  };
  dispute: Stripe.Dispute;
  invoices: {
    recovered: Stripe.Invoice;
  };
  prices: {
    annual: Stripe.Price;
    basic: Stripe.Price;
    pro: Stripe.Price;
    risk: Stripe.Price;
    trial: Stripe.Price;
  };
  subscriptions: {
    activeAnnual: Stripe.Subscription;
    activeBasic: Stripe.Subscription;
    activePro: Stripe.Subscription;
    pastDue: Stripe.Subscription;
    trialing: Stripe.Subscription;
  };
}

export interface IntegrationFixtureSnapshot {
  canceled_subscription: {
    id: string;
  };
  customers: {
    activeAnnual: { email: string | null; id: string };
    activeBasic: { email: string | null; id: string };
    activePro: { email: string | null; id: string };
    pastDue: { email: string | null; id: string };
    trialing: { email: string | null; id: string };
  };
  dispute: {
    id: string;
  };
  invoices: {
    recovered: { id: string };
  };
  prices: {
    annual: { id: string; lookup_key: string | null };
    basic: { id: string; lookup_key: string | null };
    pro: { id: string; lookup_key: string | null };
    risk: { id: string; lookup_key: string | null };
    trial: { id: string; lookup_key: string | null };
  };
  subscriptions: {
    activeAnnual: { id: string };
    activeBasic: { id: string };
    activePro: { id: string };
    pastDue: { id: string };
    trialing: { id: string };
  };
}

export const SHARED_FIXTURE_STATE_PATH = resolve(
  process.cwd(),
  ".vitest",
  "stripe-founder-mcp-integration-fixture.json"
);

let cachedFixture: IntegrationFixture | undefined;
let cachedStripeClient: Stripe | undefined;
let cachedFixtureSnapshot: IntegrationFixtureSnapshot | undefined;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecentEnough(created: number, days: number): boolean {
  return created * 1000 >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function buildFixtureSnapshot(fixture: IntegrationFixture): IntegrationFixtureSnapshot {
  return {
    canceled_subscription: {
      id: fixture.canceled_subscription.id
    },
    customers: {
      activeAnnual: { email: fixture.customers.activeAnnual.email ?? null, id: fixture.customers.activeAnnual.id },
      activeBasic: { email: fixture.customers.activeBasic.email ?? null, id: fixture.customers.activeBasic.id },
      activePro: { email: fixture.customers.activePro.email ?? null, id: fixture.customers.activePro.id },
      pastDue: { email: fixture.customers.pastDue.email ?? null, id: fixture.customers.pastDue.id },
      trialing: { email: fixture.customers.trialing.email ?? null, id: fixture.customers.trialing.id }
    },
    dispute: {
      id: fixture.dispute.id
    },
    invoices: {
      recovered: {
        id: fixture.invoices.recovered.id
      }
    },
    prices: {
      annual: { id: fixture.prices.annual.id, lookup_key: fixture.prices.annual.lookup_key ?? null },
      basic: { id: fixture.prices.basic.id, lookup_key: fixture.prices.basic.lookup_key ?? null },
      pro: { id: fixture.prices.pro.id, lookup_key: fixture.prices.pro.lookup_key ?? null },
      risk: { id: fixture.prices.risk.id, lookup_key: fixture.prices.risk.lookup_key ?? null },
      trial: { id: fixture.prices.trial.id, lookup_key: fixture.prices.trial.lookup_key ?? null }
    },
    subscriptions: {
      activeAnnual: { id: fixture.subscriptions.activeAnnual.id },
      activeBasic: { id: fixture.subscriptions.activeBasic.id },
      activePro: { id: fixture.subscriptions.activePro.id },
      pastDue: { id: fixture.subscriptions.pastDue.id },
      trialing: { id: fixture.subscriptions.trialing.id }
    }
  };
}

function fixtureMetadata(fixtureKey: string): Stripe.MetadataParam {
  return {
    fixture_key: fixtureKey,
    fixture_namespace: FIXTURE_NAMESPACE
  };
}

function getStripeApiKey(): string | undefined {
  return process.env.STRIPE_API_KEY;
}

function isDeletedCustomer(customer: Stripe.Customer | Stripe.DeletedCustomer): customer is Stripe.DeletedCustomer {
  return "deleted" in customer;
}

export function hasStripeTestKey(): boolean {
  return getStripeApiKey()?.startsWith("sk_test_") ?? false;
}

export function getIntegrationStripe(): Stripe {
  if (cachedStripeClient) {
    return cachedStripeClient;
  }

  const apiKey = getStripeApiKey();
  if (!apiKey?.startsWith("sk_test_")) {
    throw new Error("Integration tests require STRIPE_API_KEY=sk_test_...");
  }

  cachedStripeClient = new Stripe(apiKey, {
    appInfo: {
      name: "stripe-founder-mcp-integration-tests",
      version: "0.1.0"
    },
    maxNetworkRetries: 1
  });

  return cachedStripeClient;
}

async function attachDefaultPaymentMethod(
  stripe: Stripe,
  customerId: string,
  paymentMethodId: string
): Promise<string> {
  const paymentMethod = await stripe.paymentMethods.attach(paymentMethodId, {
    customer: customerId
  });

  await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethod.id
    }
  });

  return paymentMethod.id;
}

async function ensureCustomer(
  stripe: Stripe,
  fixtureKey: string,
  email: string,
  name: string
): Promise<Stripe.Customer> {
  const customers = await stripe.customers.list({
    email,
    limit: 10
  });

  const existing = customers.data.find(
    (customer) =>
      !isDeletedCustomer(customer) &&
      customer.metadata.fixture_namespace === FIXTURE_NAMESPACE &&
      customer.metadata.fixture_key === fixtureKey
  );

  if (existing && !isDeletedCustomer(existing)) {
    return existing;
  }

  return stripe.customers.create({
    email,
    metadata: fixtureMetadata(fixtureKey),
    name
  });
}

async function ensurePrice(
  stripe: Stripe,
  options: {
    interval: Stripe.PriceCreateParams.Recurring.Interval;
    lookupKey: string;
    name: string;
    unitAmount: number;
  }
): Promise<Stripe.Price> {
  const prices = await stripe.prices.list({
    expand: ["data.product"],
    limit: 1,
    lookup_keys: [options.lookupKey]
  });

  const existing = prices.data[0];
  if (existing) {
    return existing;
  }

  const product = await stripe.products.create({
    metadata: fixtureMetadata(options.lookupKey),
    name: options.name
  });

  return stripe.prices.create({
    currency: "usd",
    lookup_key: options.lookupKey,
    metadata: fixtureMetadata(options.lookupKey),
    nickname: options.name,
    product: product.id,
    recurring: {
      interval: options.interval
    },
    unit_amount: options.unitAmount
  });
}

async function listCustomerSubscriptions(stripe: Stripe, customerId: string): Promise<Stripe.Subscription[]> {
  const response = await stripe.subscriptions.list({
    customer: customerId,
    expand: [...SUBSCRIPTION_EXPAND],
    limit: 100,
    status: "all"
  });

  return response.data
    .filter((subscription) => subscription.metadata.fixture_namespace === FIXTURE_NAMESPACE)
    .sort((left, right) => right.created - left.created);
}

async function findCustomerSubscription(
  stripe: Stripe,
  customerId: string,
  fixtureKey: string
): Promise<Stripe.Subscription | undefined> {
  const subscriptions = await listCustomerSubscriptions(stripe, customerId);
  return subscriptions.find((subscription) => subscription.metadata.fixture_key === fixtureKey);
}

async function ensureActiveSubscription(
  stripe: Stripe,
  customer: Stripe.Customer,
  fixtureKey: string,
  priceId: string
): Promise<Stripe.Subscription> {
  const existing = await findCustomerSubscription(stripe, customer.id, fixtureKey);
  if (existing && existing.status === "active") {
    return existing;
  }

  await attachDefaultPaymentMethod(stripe, customer.id, "pm_card_visa");

  return stripe.subscriptions.create({
    customer: customer.id,
    expand: ["latest_invoice.payment_intent", "items.data.price"],
    items: [{ price: priceId }],
    metadata: fixtureMetadata(fixtureKey)
  });
}

async function ensureTrialingSubscription(
  stripe: Stripe,
  customer: Stripe.Customer,
  priceId: string
): Promise<Stripe.Subscription> {
  const existing = await findCustomerSubscription(stripe, customer.id, RESOURCE_KEYS.trialingSubscription);
  if (existing && existing.status === "trialing") {
    return existing;
  }

  await attachDefaultPaymentMethod(stripe, customer.id, "pm_card_visa");

  return stripe.subscriptions.create({
    customer: customer.id,
    expand: ["latest_invoice.payment_intent", "items.data.price"],
    items: [{ price: priceId }],
    metadata: fixtureMetadata(RESOURCE_KEYS.trialingSubscription),
    trial_end: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  });
}

async function waitForSubscriptionStatus(
  stripe: Stripe,
  subscriptionId: string,
  expectedStatus: Stripe.Subscription.Status,
  timeoutMs = 45_000
): Promise<Stripe.Subscription> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice.payment_intent", "items.data.price"]
    });

    if (subscription.status === expectedStatus) {
      return subscription;
    }

    await delay(2_000);
  }

  const latestSubscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["latest_invoice.payment_intent", "items.data.price"]
  });
  throw new Error(`Expected ${subscriptionId} to become ${expectedStatus}, received ${latestSubscription.status}.`);
}

async function ensurePastDueSubscription(
  stripe: Stripe,
  customer: Stripe.Customer,
  priceId: string
): Promise<Stripe.Subscription> {
  const existing = await findCustomerSubscription(stripe, customer.id, RESOURCE_KEYS.pastDueSubscription);
  if (existing?.status === "past_due") {
    return existing;
  }

  let subscription = existing;
  if (subscription && subscription.status !== "canceled") {
    await stripe.subscriptions.cancel(subscription.id);
    subscription = undefined;
  }

  const successfulPaymentMethodId = await attachDefaultPaymentMethod(stripe, customer.id, "pm_card_visa");
  subscription = await stripe.subscriptions.create({
    customer: customer.id,
    default_payment_method: successfulPaymentMethodId,
    expand: ["latest_invoice.payment_intent", "items.data.price"],
    items: [{ price: priceId }],
    metadata: fixtureMetadata(RESOURCE_KEYS.pastDueSubscription)
  });

  const subscriptionItemId = subscription.items.data[0]?.id;
  if (!subscriptionItemId) {
    throw new Error(`Past-due fixture subscription ${subscription.id} was created without a subscription item.`);
  }

  const failingPaymentMethodId = await attachDefaultPaymentMethod(stripe, customer.id, "pm_card_chargeCustomerFail");
  await stripe.subscriptions.update(subscription.id, {
    default_payment_method: failingPaymentMethodId,
    expand: ["latest_invoice.payment_intent", "items.data.price"],
    items: [
      {
        id: subscriptionItemId,
        price: priceId,
        quantity: 2
      }
    ],
    proration_behavior: "always_invoice"
  });
  return waitForSubscriptionStatus(stripe, subscription.id, "past_due");
}

async function ensureCanceledSubscriptionWithFeedback(
  stripe: Stripe,
  customer: Stripe.Customer,
  priceId: string
): Promise<Stripe.Subscription> {
  const existing = await findCustomerSubscription(stripe, customer.id, RESOURCE_KEYS.canceledFeedback);
  if (existing?.status === "canceled" && existing.cancellation_details?.feedback) {
    return existing;
  }

  await attachDefaultPaymentMethod(stripe, customer.id, "pm_card_visa");

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    expand: ["latest_invoice.payment_intent", "items.data.price"],
    items: [{ price: priceId }],
    metadata: fixtureMetadata(RESOURCE_KEYS.canceledFeedback)
  });

  return stripe.subscriptions.cancel(subscription.id, {
    cancellation_details: {
      feedback: "too_expensive"
    }
  });
}

async function ensureSucceededCharge(
  stripe: Stripe,
  customerId: string,
  fixtureKey: string,
  paymentMethodId: string
): Promise<Stripe.Charge> {
  const charges = await stripe.charges.list({
    customer: customerId,
    limit: 100
  });

  const existing = charges.data.find(
    (charge) => charge.metadata.fixture_namespace === FIXTURE_NAMESPACE && charge.metadata.fixture_key === fixtureKey
  );

  if (existing && existing.status === "succeeded") {
    return existing;
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: fixtureKey === RESOURCE_KEYS.disputedCharge ? 2_900 : 1_900,
    confirm: true,
    currency: "usd",
    customer: customerId,
    expand: ["latest_charge"],
    metadata: fixtureMetadata(fixtureKey),
    off_session: true,
    payment_method: paymentMethodId
  });

  const latestCharge = paymentIntent.latest_charge;
  if (!latestCharge || typeof latestCharge === "string") {
    throw new Error(`PaymentIntent ${paymentIntent.id} did not return an expanded latest_charge.`);
  }

  return latestCharge;
}

async function waitForDispute(
  stripe: Stripe,
  chargeId: string,
  timeoutMs = 45_000
): Promise<Stripe.Dispute> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const disputes = await stripe.disputes.list({
      limit: 100
    });

    const dispute = disputes.data.find((candidate) => candidate.charge === chargeId);
    if (dispute) {
      return dispute;
    }

    await delay(2_000);
  }

  throw new Error(`Timed out waiting for dispute on charge ${chargeId}.`);
}

async function ensureRecoveredFailedInvoice(stripe: Stripe, customerId: string): Promise<Stripe.Invoice> {
  const invoices = await stripe.invoices.list({
    customer: customerId,
    expand: ["data.payment_intent", "data.charge", "data.subscription"],
    limit: 100
  });

  const existing = invoices.data.find(
    (invoice) =>
      invoice.metadata?.fixture_namespace === FIXTURE_NAMESPACE &&
      invoice.metadata?.fixture_key === RESOURCE_KEYS.failedRecoveredInvoice &&
      invoice.paid &&
      isRecentEnough(invoice.created, 25)
  );

  if (existing) {
    return existing;
  }

  const targetSubscription =
    (await findCustomerSubscription(stripe, customerId, RESOURCE_KEYS.activeAnnual)) ??
    (await listCustomerSubscriptions(stripe, customerId)).find(
      (subscription) => subscription.status !== "canceled" && subscription.items.data.length > 0
    );

  if (!targetSubscription) {
    throw new Error(`Unable to find a live fixture subscription for recovered invoice customer ${customerId}.`);
  }

  const subscriptionItem = targetSubscription.items.data[0];
  if (!subscriptionItem) {
    throw new Error(`Fixture subscription ${targetSubscription.id} has no items to invoice against.`);
  }

  const originalQuantity = subscriptionItem.quantity ?? 1;
  const successfulPaymentMethodId = await attachDefaultPaymentMethod(stripe, customerId, "pm_card_visa");

  const recoverSubscriptionToActive = async (): Promise<void> => {
    await stripe.subscriptions.update(targetSubscription.id, {
      default_payment_method: successfulPaymentMethodId,
      items: [
        {
          id: subscriptionItem.id,
          price: subscriptionItem.price.id,
          quantity: originalQuantity
        }
      ],
      proration_behavior: "none"
    });

    await waitForSubscriptionStatus(stripe, targetSubscription.id, "active");
  };

  const existingUnpaidFixtureInvoice = invoices.data.find(
    (invoice) =>
      invoice.metadata?.fixture_namespace === FIXTURE_NAMESPACE &&
      invoice.metadata?.fixture_key === RESOURCE_KEYS.failedRecoveredInvoice &&
      !invoice.paid
  );

  if (existingUnpaidFixtureInvoice) {
    const recoveredInvoice = await stripe.invoices.pay(existingUnpaidFixtureInvoice.id, {
      expand: ["payment_intent", "charge", "subscription"],
      off_session: true,
      payment_method: successfulPaymentMethodId
    });

    await recoverSubscriptionToActive();
    return recoveredInvoice;
  }

  if (targetSubscription.status === "past_due") {
    const pastDueInvoiceId =
      typeof targetSubscription.latest_invoice === "string"
        ? targetSubscription.latest_invoice
        : targetSubscription.latest_invoice?.id;

    if (pastDueInvoiceId) {
      await stripe.invoices.update(pastDueInvoiceId, {
        metadata: fixtureMetadata(RESOURCE_KEYS.failedRecoveredInvoice)
      });

      const recoveredInvoice = await stripe.invoices.pay(pastDueInvoiceId, {
        expand: ["payment_intent", "charge", "subscription"],
        off_session: true,
        payment_method: successfulPaymentMethodId
      });

      await recoverSubscriptionToActive();
      return recoveredInvoice;
    }
  }

  const failingPaymentMethodId = await attachDefaultPaymentMethod(stripe, customerId, "pm_card_chargeCustomerFail");
  const failedSubscription = await stripe.subscriptions.update(targetSubscription.id, {
    default_payment_method: failingPaymentMethodId,
    expand: ["latest_invoice.payment_intent", "items.data.price"],
    items: [
      {
        id: subscriptionItem.id,
        price: subscriptionItem.price.id,
        quantity: originalQuantity + 1
      }
    ],
    proration_behavior: "always_invoice"
  });

  const pastDueSubscription = await waitForSubscriptionStatus(stripe, failedSubscription.id, "past_due");
  const failedInvoiceId =
    typeof pastDueSubscription.latest_invoice === "string"
      ? pastDueSubscription.latest_invoice
      : pastDueSubscription.latest_invoice?.id;

  if (!failedInvoiceId) {
    throw new Error(`Subscription ${pastDueSubscription.id} did not expose a latest invoice after a failed retry.`);
  }

  await stripe.invoices.update(failedInvoiceId, {
    metadata: fixtureMetadata(RESOURCE_KEYS.failedRecoveredInvoice)
  });

  const recoveredInvoice = await stripe.invoices.pay(failedInvoiceId, {
    expand: ["payment_intent", "charge", "subscription"],
    off_session: true,
    payment_method: successfulPaymentMethodId
  });

  await recoverSubscriptionToActive();
  return recoveredInvoice;
}

async function cancelFixtureSubscriptions(stripe: Stripe, customerId: string): Promise<void> {
  const subscriptions = await listCustomerSubscriptions(stripe, customerId);

  for (const subscription of subscriptions) {
    if (subscription.status === "active" || subscription.status === "trialing" || subscription.status === "past_due") {
      await stripe.subscriptions.cancel(subscription.id);
    }
  }
}

export async function seedFixture(): Promise<IntegrationFixture> {
  if (cachedFixture) {
    return cachedFixture;
  }

  const stripe = getIntegrationStripe();
  const [basic, pro, annual, trial, risk] = await Promise.all([
    ensurePrice(stripe, { interval: "month", lookupKey: PRICE_KEYS.basic, name: "Fixture Basic", unitAmount: 1_500 }),
    ensurePrice(stripe, { interval: "month", lookupKey: PRICE_KEYS.pro, name: "Fixture Pro", unitAmount: 3_500 }),
    ensurePrice(stripe, { interval: "year", lookupKey: PRICE_KEYS.annual, name: "Fixture Annual", unitAmount: 24_000 }),
    ensurePrice(stripe, { interval: "month", lookupKey: PRICE_KEYS.trial, name: "Fixture Trial", unitAmount: 800 }),
    ensurePrice(stripe, { interval: "month", lookupKey: PRICE_KEYS.risk, name: "Fixture Risk", unitAmount: 2_000 })
  ]);

  const [activeBasic, activePro, activeAnnual, trialingCustomer] = await Promise.all([
    ensureCustomer(stripe, "customer_active_basic", CUSTOMER_EMAILS.activeBasic, "Fixture Active Basic"),
    ensureCustomer(stripe, "customer_active_pro", CUSTOMER_EMAILS.activePro, "Fixture Active Pro"),
    ensureCustomer(stripe, "customer_active_annual", CUSTOMER_EMAILS.activeAnnual, "Fixture Active Annual"),
    ensureCustomer(stripe, "customer_trialing", CUSTOMER_EMAILS.trialing, "Fixture Trialing")
  ]);
  const pastDueCustomer = await ensureCustomer(stripe, "customer_past_due", CUSTOMER_EMAILS.pastDue, "Fixture Past Due");

  const subscriptions = {
    activeAnnual: await ensureActiveSubscription(stripe, activeAnnual, RESOURCE_KEYS.activeAnnual, annual.id),
    activeBasic: await ensureActiveSubscription(stripe, activeBasic, RESOURCE_KEYS.activeBasic, basic.id),
    activePro: await ensureActiveSubscription(stripe, activePro, RESOURCE_KEYS.activePro, pro.id),
    pastDue: await ensurePastDueSubscription(stripe, pastDueCustomer, risk.id),
    trialing: await ensureTrialingSubscription(stripe, trialingCustomer, trial.id)
  };

  const canceledSubscription = await ensureCanceledSubscriptionWithFeedback(
    stripe,
    activeBasic,
    basic.id
  );

  await ensureSucceededCharge(stripe, activeBasic.id, RESOURCE_KEYS.successfulCharge, "pm_card_visa");
  const disputedCharge = await ensureSucceededCharge(
    stripe,
    activePro.id,
    RESOURCE_KEYS.disputedCharge,
    "pm_card_createDispute"
  );
  const dispute = await waitForDispute(stripe, disputedCharge.id);
  const recoveredInvoice = await ensureRecoveredFailedInvoice(stripe, activeAnnual.id);

  cachedFixture = {
    canceled_subscription: canceledSubscription,
    customers: {
      activeAnnual,
      activeBasic,
      activePro,
      pastDue: pastDueCustomer,
      trialing: trialingCustomer
    },
    dispute,
    invoices: {
      recovered: recoveredInvoice
    },
    prices: {
      annual,
      basic,
      pro,
      risk,
      trial
    },
    subscriptions
  };
  cachedFixtureSnapshot = buildFixtureSnapshot(cachedFixture);

  return cachedFixture;
}

export async function writeSharedFixtureSnapshot(snapshot: IntegrationFixtureSnapshot): Promise<void> {
  await mkdir(dirname(SHARED_FIXTURE_STATE_PATH), {
    recursive: true
  });
  await writeFile(SHARED_FIXTURE_STATE_PATH, JSON.stringify(snapshot, null, 2), "utf8");
  cachedFixtureSnapshot = snapshot;
}

export async function readSharedFixtureSnapshot(): Promise<IntegrationFixtureSnapshot> {
  if (cachedFixtureSnapshot) {
    return cachedFixtureSnapshot;
  }

  const raw = await readFile(SHARED_FIXTURE_STATE_PATH, "utf8");
  cachedFixtureSnapshot = JSON.parse(raw) as IntegrationFixtureSnapshot;
  return cachedFixtureSnapshot;
}

export async function removeSharedFixtureSnapshot(): Promise<void> {
  cachedFixtureSnapshot = undefined;
  await rm(SHARED_FIXTURE_STATE_PATH, {
    force: true
  });
}

export async function seedSharedFixtureSnapshot(): Promise<IntegrationFixtureSnapshot> {
  const fixture = await seedFixture();
  const snapshot = buildFixtureSnapshot(fixture);
  await writeSharedFixtureSnapshot(snapshot);
  return snapshot;
}

export async function cleanupFixture(): Promise<void> {
  const stripe = getIntegrationStripe();
  const fixture = cachedFixture;

  if (!fixture) {
    return;
  }

  await Promise.all([
    cancelFixtureSubscriptions(stripe, fixture.customers.activeAnnual.id),
    cancelFixtureSubscriptions(stripe, fixture.customers.activeBasic.id),
    cancelFixtureSubscriptions(stripe, fixture.customers.activePro.id),
    cancelFixtureSubscriptions(stripe, fixture.customers.trialing.id),
    cancelFixtureSubscriptions(stripe, fixture.customers.pastDue.id)
  ]);

  cachedFixture = undefined;
}
