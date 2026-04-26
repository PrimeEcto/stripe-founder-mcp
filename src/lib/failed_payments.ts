import type Stripe from "stripe";

import type { NormalizedDateRange } from "./types.js";
import { createdToIso, customerEmailFromExpandable, customerIdFromExpandable } from "./stripe_records.js";
import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

const OPEN_INVOICE_EXPAND = ["data.customer", "data.payment_intent", "data.charge", "data.subscription"] as const;
const PAYMENT_INTENT_LIST_EXPAND = [
  "data.customer",
  "data.invoice.customer",
  "data.invoice.subscription",
  "data.latest_charge"
] as const;
const PAYMENT_INTENT_RETRIEVE_EXPAND = ["customer", "invoice.customer", "invoice.subscription", "latest_charge"] as const;
const INVOICE_RETRIEVE_EXPAND = ["customer", "payment_intent", "charge", "subscription"] as const;

export type FailedPaymentState = "final_failure" | "recovered" | "retrying";

export interface FailedPaymentRecord {
  amount_cents: number;
  attempted_at_iso: string;
  attempt_count: number;
  customer_email: string | null;
  customer_id: string | null;
  current_state: FailedPaymentState;
  failure_code: string | null;
  failure_message: string | null;
  invoice_id: string;
  payment_intent_id: string | null;
  recovered_amount_cents: number;
  retry_scheduled_for_iso: string | null;
  subscription_id: string | null;
}

export interface FailedPaymentCollection {
  caveats: string[];
  records: FailedPaymentRecord[];
  truncated: boolean;
}

function getChargeInvoiceId(charge: Stripe.Charge): string | null {
  if (!charge.invoice) {
    return null;
  }

  return typeof charge.invoice === "string" ? charge.invoice : charge.invoice.id;
}

function getChargePaymentIntentId(charge: Stripe.Charge): string | null {
  if (!charge.payment_intent) {
    return null;
  }

  return typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id;
}

function getInvoiceFromPaymentIntent(paymentIntent: Stripe.PaymentIntent | null | undefined): Stripe.Invoice | null {
  if (!paymentIntent?.invoice || typeof paymentIntent.invoice === "string") {
    return null;
  }

  return paymentIntent.invoice;
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice | null | undefined): string | null {
  if (!invoice?.subscription) {
    return null;
  }

  return typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription.id;
}

function getInvoiceCustomerId(invoice: Stripe.Invoice | null | undefined): string | null {
  return customerIdFromExpandable(invoice?.customer) ?? null;
}

function getInvoiceCustomerEmail(invoice: Stripe.Invoice | null | undefined): string | null {
  return customerEmailFromExpandable(invoice?.customer) ?? invoice?.customer_email ?? null;
}

function getPaymentIntentCustomerId(paymentIntent: Stripe.PaymentIntent | null | undefined): string | null {
  return customerIdFromExpandable(paymentIntent?.customer) ?? null;
}

function getPaymentIntentCustomerEmail(paymentIntent: Stripe.PaymentIntent | null | undefined): string | null {
  return customerEmailFromExpandable(paymentIntent?.customer) ?? null;
}

function classifyFailedPaymentState(
  currentInvoice: Stripe.Invoice | null,
  paymentIntent: Stripe.PaymentIntent | null
): FailedPaymentState {
  if (currentInvoice?.paid || currentInvoice?.status === "paid" || paymentIntent?.status === "succeeded") {
    return "recovered";
  }

  if (currentInvoice?.next_payment_attempt) {
    return "retrying";
  }

  return "final_failure";
}

function buildFailureDetails(
  failedCharge: Stripe.Charge,
  paymentIntent: Stripe.PaymentIntent | null
): {
  failure_code: string | null;
  failure_message: string | null;
  payment_intent_id: string | null;
} {
  if (failedCharge.failure_code || failedCharge.failure_message) {
    return {
      failure_code: failedCharge.failure_code ?? null,
      failure_message: failedCharge.failure_message ?? null,
      payment_intent_id: getChargePaymentIntentId(failedCharge)
    };
  }

  return {
    failure_code: paymentIntent?.last_payment_error?.code ?? null,
    failure_message: paymentIntent?.last_payment_error?.message ?? null,
    payment_intent_id: paymentIntent?.id ?? null
  };
}

async function loadOpenInvoices(
  period: NormalizedDateRange,
  cacheKey: string
): Promise<ReturnType<typeof collectAutoPaged<Stripe.Invoice>>> {
  const stripeClient = getStripeClientContext();

  return stripeClient.getCachedToolResult(
    `${cacheKey}:open_invoices`,
    {
      end_iso: period.end_iso,
      start_iso: period.start_iso
    },
    async () =>
      collectAutoPaged(
        stripeClient.stripe.invoices.list({
          created: {
            gte: Math.floor(period.start.getTime() / 1000),
            lt: Math.floor(period.end.getTime() / 1000)
          },
          expand: [...OPEN_INVOICE_EXPAND],
          limit: 100,
          status: "open"
        }),
        stripeClient.maxListResults
      )
  );
}

async function loadPaymentIntents(
  period: NormalizedDateRange,
  cacheKey: string
): Promise<ReturnType<typeof collectAutoPaged<Stripe.PaymentIntent>>> {
  const stripeClient = getStripeClientContext();

  return stripeClient.getCachedToolResult(
    `${cacheKey}:payment_intents`,
    {
      end_iso: period.end_iso,
      start_iso: period.start_iso
    },
    async () =>
      collectAutoPaged(
        stripeClient.stripe.paymentIntents.list({
          created: {
            gte: Math.floor(period.start.getTime() / 1000),
            lt: Math.floor(period.end.getTime() / 1000)
          },
          expand: [...PAYMENT_INTENT_LIST_EXPAND],
          limit: 100
        }),
        stripeClient.maxListResults
      )
  );
}

async function loadCharges(
  period: NormalizedDateRange,
  cacheKey: string
): Promise<ReturnType<typeof collectAutoPaged<Stripe.Charge>>> {
  const stripeClient = getStripeClientContext();

  return stripeClient.getCachedToolResult(
    `${cacheKey}:charges`,
    {
      end_iso: period.end_iso,
      start_iso: period.start_iso
    },
    async () =>
      collectAutoPaged(
        stripeClient.stripe.charges.list({
          created: {
            gte: Math.floor(period.start.getTime() / 1000),
            lt: Math.floor(period.end.getTime() / 1000)
          },
          limit: 100
        }),
        stripeClient.maxListResults
      )
  );
}

export async function loadFailedPaymentRecords(
  period: NormalizedDateRange,
  cacheKey: string
): Promise<FailedPaymentCollection> {
  const stripeClient = getStripeClientContext();

  const [openInvoices, paymentIntents, charges] = await Promise.all([
    loadOpenInvoices(period, cacheKey),
    loadPaymentIntents(period, cacheKey),
    loadCharges(period, cacheKey)
  ]);

  const failedCharges = charges.items
    .filter((charge) => charge.status === "failed")
    .filter((charge) => Boolean(getChargePaymentIntentId(charge)))
    .sort((left, right) => right.created - left.created);

  const paymentIntentMap = new Map<string, Stripe.PaymentIntent>();
  for (const paymentIntent of paymentIntents.items) {
    paymentIntentMap.set(paymentIntent.id, paymentIntent);
  }

  const openInvoiceMap = new Map<string, Stripe.Invoice>();
  for (const invoice of openInvoices.items) {
    openInvoiceMap.set(invoice.id, invoice);
  }

  const omittedNonInvoiceCharges = new Set<string>();
  for (const charge of failedCharges) {
    const paymentIntentId = getChargePaymentIntentId(charge);
    if (!paymentIntentId) {
      continue;
    }

    if (!paymentIntentMap.has(paymentIntentId)) {
      const paymentIntent = await stripeClient.getCachedToolResult(
        `${cacheKey}:payment_intent:${paymentIntentId}`,
        {},
        async () =>
          stripeClient.stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: [...PAYMENT_INTENT_RETRIEVE_EXPAND]
          })
      );

      paymentIntentMap.set(paymentIntentId, paymentIntent);
    }
  }

  const currentInvoiceMap = new Map<string, Stripe.Invoice>();
  for (const charge of failedCharges) {
    const paymentIntentId = getChargePaymentIntentId(charge);
    if (!paymentIntentId) {
      continue;
    }

    const paymentIntent = paymentIntentMap.get(paymentIntentId) ?? null;
    const invoiceId = getChargeInvoiceId(charge) ?? getInvoiceFromPaymentIntent(paymentIntent)?.id ?? null;

    if (!invoiceId) {
      omittedNonInvoiceCharges.add(charge.id);
      continue;
    }

    if (currentInvoiceMap.has(invoiceId)) {
      continue;
    }

    if (openInvoiceMap.has(invoiceId)) {
      currentInvoiceMap.set(invoiceId, openInvoiceMap.get(invoiceId)!);
      continue;
    }

    const expandedInvoiceFromPaymentIntent = getInvoiceFromPaymentIntent(paymentIntent);
    if (expandedInvoiceFromPaymentIntent) {
      currentInvoiceMap.set(invoiceId, expandedInvoiceFromPaymentIntent);
      continue;
    }

    const invoice = await stripeClient.getCachedToolResult(`${cacheKey}:invoice:${invoiceId}`, {}, async () =>
      stripeClient.stripe.invoices.retrieve(invoiceId, {
        expand: [...INVOICE_RETRIEVE_EXPAND]
      })
    );
    currentInvoiceMap.set(invoiceId, invoice);
  }

  const records: FailedPaymentRecord[] = [];
  for (const failedCharge of failedCharges) {
    const paymentIntentId = getChargePaymentIntentId(failedCharge);
    if (!paymentIntentId) {
      continue;
    }

    const paymentIntent = paymentIntentMap.get(paymentIntentId) ?? null;
    const invoiceId = getChargeInvoiceId(failedCharge) ?? getInvoiceFromPaymentIntent(paymentIntent)?.id ?? null;
    if (!invoiceId) {
      continue;
    }

    const currentInvoice = currentInvoiceMap.get(invoiceId) ?? null;
    const currentState = classifyFailedPaymentState(currentInvoice, paymentIntent);
    const failureDetails = buildFailureDetails(failedCharge, paymentIntent);

    records.push({
      amount_cents: failedCharge.amount || currentInvoice?.total || paymentIntent?.amount || 0,
      attempted_at_iso: createdToIso(failedCharge.created) ?? new Date(failedCharge.created * 1000).toISOString(),
      attempt_count: currentInvoice?.attempt_count ?? 1,
      customer_email:
        getInvoiceCustomerEmail(currentInvoice) ??
        getPaymentIntentCustomerEmail(paymentIntent) ??
        customerEmailFromExpandable(failedCharge.customer) ??
        failedCharge.billing_details?.email ??
        null,
      customer_id:
        getInvoiceCustomerId(currentInvoice) ??
        getPaymentIntentCustomerId(paymentIntent) ??
        customerIdFromExpandable(failedCharge.customer) ??
        null,
      current_state: currentState,
      failure_code: failureDetails.failure_code,
      failure_message: failureDetails.failure_message,
      invoice_id: invoiceId,
      payment_intent_id: failureDetails.payment_intent_id,
      recovered_amount_cents:
        currentState === "recovered"
          ? currentInvoice?.amount_paid ?? paymentIntent?.amount_received ?? currentInvoice?.total ?? 0
          : 0,
      retry_scheduled_for_iso: createdToIso(currentInvoice?.next_payment_attempt ?? undefined),
      subscription_id: getInvoiceSubscriptionId(currentInvoice)
    });
  }

  records.sort((left, right) => right.attempted_at_iso.localeCompare(left.attempted_at_iso));

  const caveats: string[] = [];
  if (omittedNonInvoiceCharges.size > 0) {
    caveats.push("Some failed charges were omitted because they were not attached to an invoice-backed payment.");
  }

  return {
    caveats,
    records,
    truncated: openInvoices.truncated || paymentIntents.truncated || charges.truncated
  };
}
