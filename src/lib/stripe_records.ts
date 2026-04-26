import type Stripe from "stripe";

export function createdToIso(created: number | null | undefined): string | null {
  if (!created) {
    return null;
  }

  return new Date(created * 1000).toISOString();
}

export function customerIdFromExpandable(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | undefined {
  if (!customer) {
    return undefined;
  }

  return typeof customer === "string" ? customer : customer.id;
}

export function customerEmailFromExpandable(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (!customer || typeof customer === "string" || "deleted" in customer) {
    return null;
  }

  return customer.email ?? null;
}

export function customerNameFromExpandable(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (!customer || typeof customer === "string" || "deleted" in customer) {
    return null;
  }

  return customer.name ?? null;
}

export function getDefaultPaymentMethod(
  customer: Stripe.Customer | Stripe.DeletedCustomer
): Stripe.PaymentMethod | null {
  if ("deleted" in customer) {
    return null;
  }

  const paymentMethod = customer.invoice_settings.default_payment_method;
  if (!paymentMethod || typeof paymentMethod === "string") {
    return null;
  }

  return paymentMethod;
}

export function getPaymentMethodLast4(customer: Stripe.Customer | Stripe.DeletedCustomer): string | null {
  const paymentMethod = getDefaultPaymentMethod(customer);
  if (!paymentMethod || paymentMethod.type !== "card") {
    return null;
  }

  return paymentMethod.card?.last4 ?? null;
}
