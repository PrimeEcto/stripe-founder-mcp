import type Stripe from "stripe";
import { z } from "zod";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { listAtRiskCustomersTool } from "../../../src/tools/list_at_risk_customers.js";
import { createAutoPagedCollection, createMockStripeClientContext } from "../helpers/mockStripe.js";

const getStripeClientContextMock = vi.fn();
const loadFailedPaymentRecordsMock = vi.fn();

vi.mock("../../../src/stripe/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/stripe/client.js")>(
    "../../../src/stripe/client.js"
  );

  return {
    ...actual,
    getStripeClientContext: () => getStripeClientContextMock()
  };
});

vi.mock("../../../src/lib/failed_payments.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/failed_payments.js")>(
    "../../../src/lib/failed_payments.js"
  );

  return {
    ...actual,
    loadFailedPaymentRecords: (...args: unknown[]) => loadFailedPaymentRecordsMock(...args)
  };
});

function createSubscription(
  overrides: Partial<Stripe.Subscription> & {
    customerEmail: string;
    customerId: string;
    id: string;
    status: Stripe.Subscription.Status;
    unitAmount: number;
  }
): Stripe.Subscription {
  const {
    customerEmail,
    customerId,
    id,
    status,
    unitAmount,
    ...rest
  } = overrides;

  return {
    cancel_at: null,
    canceled_at: null,
    created: 1_700_000_000,
    currency: "usd",
    customer: {
      created: 1_700_000_000,
      email: customerEmail,
      id: customerId,
      invoice_settings: {
        custom_fields: null,
        default_payment_method: null,
        footer: null,
        rendering_options: null
      },
      metadata: {},
      name: customerEmail,
      object: "customer"
    },
    ended_at: null,
    id,
    items: {
      data: [
        {
          id: `${id}_item`,
          object: "subscription_item",
          price: {
            currency: "usd",
            id: `${id}_price`,
            nickname: `${id}_price`,
            object: "price",
            product: {
              id: `${id}_product`,
              name: `${id} plan`,
              object: "product"
            },
            recurring: {
              interval: "month",
              interval_count: 1,
              usage_type: "licensed"
            },
            unit_amount: unitAmount
          },
          quantity: 1
        }
      ],
      has_more: false,
      object: "list",
      url: "/v1/subscription_items"
    },
    object: "subscription",
    pause_collection: null,
    status,
    trial_end: null,
    ...rest
  } as unknown as Stripe.Subscription;
}

function parsePayload(response: unknown): {
  context: { caveats: string[]; signals_applied: string[] };
  items: Array<{ customer_id: string; mrr_cents: number; risk_signal: string }>;
  summary: { at_risk_count: number; total_mrr_at_risk_cents: number };
} {
  const text = (response as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as {
    context: { caveats: string[]; signals_applied: string[] };
    items: Array<{ customer_id: string; mrr_cents: number; risk_signal: string }>;
    summary: { at_risk_count: number; total_mrr_at_risk_cents: number };
  };
}

describe("list_at_risk_customers", () => {
  beforeEach(() => {
    getStripeClientContextMock.mockReset();
    loadFailedPaymentRecordsMock.mockReset();
  });

  it("defines described optional input fields", () => {
    const parameters = listAtRiskCustomersTool.parameters;
    const parsed = parameters?.safeParse({
      limit: 10,
      risk_signals: ["past_due", "payment_failed"]
    });
    const shape = parameters instanceof z.ZodObject ? parameters.shape : ({} as Record<string, z.ZodTypeAny>);

    expect(parsed?.success).toBe(true);
    expect(shape.limit?.description).toContain("maximum number");
    expect(shape.risk_signals?.description).toContain("risk signals");
  });

  it("returns unique MRR-at-risk totals while surfacing each selected risk signal", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        subscriptions: {
          list: (params?: Stripe.SubscriptionListParams) => {
            if (params?.status === "active") {
              return createAutoPagedCollection([
                createSubscription({
                  customerEmail: "payfail@example.com",
                  customerId: "cus_payfail",
                  id: "sub_active_payfail",
                  status: "active",
                  unitAmount: 3_000
                })
              ]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>;
            }

            if (params?.status === "past_due") {
              return createAutoPagedCollection([
                createSubscription({
                  customerEmail: "pastdue@example.com",
                  customerId: "cus_pastdue",
                  id: "sub_past_due",
                  status: "past_due",
                  unitAmount: 2_000
                })
              ]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>;
            }

            return createAutoPagedCollection([]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>;
          }
        }
      })
    );

    loadFailedPaymentRecordsMock.mockResolvedValue({
      caveats: [],
      records: [
        {
          amount_cents: 3_000,
          attempted_at_iso: "2026-04-20T12:00:00.000Z",
          attempt_count: 2,
          customer_email: "payfail@example.com",
          customer_id: "cus_payfail",
          current_state: "retrying",
          failure_code: "card_declined",
          failure_message: "Declined",
          invoice_id: "in_retry",
          payment_intent_id: "pi_retry",
          recovered_amount_cents: 0,
          retry_scheduled_for_iso: "2026-04-21T12:00:00.000Z",
          subscription_id: "sub_active_payfail"
        },
        {
          amount_cents: 3_000,
          attempted_at_iso: "2026-04-18T12:00:00.000Z",
          attempt_count: 1,
          customer_email: "payfail@example.com",
          customer_id: "cus_payfail",
          current_state: "final_failure",
          failure_code: "insufficient_funds",
          failure_message: "No funds",
          invoice_id: "in_final",
          payment_intent_id: "pi_final",
          recovered_amount_cents: 0,
          retry_scheduled_for_iso: null,
          subscription_id: "sub_active_payfail"
        }
      ],
      truncated: false
    });

    const payload = parsePayload(await listAtRiskCustomersTool.execute({}, {} as never));

    expect(payload.summary.at_risk_count).toBe(2);
    expect(payload.summary.total_mrr_at_risk_cents).toBe(5_000);
    expect(payload.items.map((item) => item.risk_signal)).toEqual([
      "payment_failed",
      "multiple_failed_attempts",
      "past_due"
    ]);
    expect(payload.items[0]?.mrr_cents).toBe(3_000);
    expect(payload.context.caveats[0]).toContain("MRR at risk includes only active and past_due subscriptions");
  });

  it("propagates loader failures", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        subscriptions: {
          list: () => createAutoPagedCollection([]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>
        }
      })
    );

    loadFailedPaymentRecordsMock.mockRejectedValue(new Error("Stripe failed-payment data unavailable"));

    await expect(listAtRiskCustomersTool.execute({}, {} as never)).rejects.toThrow(
      /Stripe failed-payment data unavailable/
    );
  });
});
