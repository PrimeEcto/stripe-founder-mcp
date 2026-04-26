import type Stripe from "stripe";
import { z } from "zod";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getChurnSummaryTool } from "../../../src/tools/get_churn_summary.js";
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
    canceledAt?: number | null;
    customerId: string;
    id: string;
    status: Stripe.Subscription.Status;
    unitAmount: number;
  }
): Stripe.Subscription {
  const {
    canceledAt = null,
    customerId,
    id,
    status,
    unitAmount,
    ...rest
  } = overrides;

  return {
    cancel_at: null,
    canceled_at: canceledAt,
    cancellation_details: rest.cancellation_details ?? null,
    created: 1_710_000_000,
    currency: "usd",
    customer: customerId,
    ended_at: canceledAt,
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
  items: Array<{ count: number; mrr_cents: number; reason: string }>;
  summary: {
    churned_mrr_cents: number;
    involuntary_count: number;
    total_churned_count: number;
    voluntary_count: number;
  };
} {
  const text = (response as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as {
    items: Array<{ count: number; mrr_cents: number; reason: string }>;
    summary: {
      churned_mrr_cents: number;
      involuntary_count: number;
      total_churned_count: number;
      voluntary_count: number;
    };
  };
}

describe("get_churn_summary", () => {
  beforeEach(() => {
    getStripeClientContextMock.mockReset();
    loadFailedPaymentRecordsMock.mockReset();
  });

  it("defines a described optional period field", () => {
    const parameters = getChurnSummaryTool.parameters;
    const parsed = parameters?.safeParse({
      period: "this_month"
    });
    const shape = parameters instanceof z.ZodObject ? parameters.shape : ({} as Record<string, z.ZodTypeAny>);

    expect(parsed?.success).toBe(true);
    expect(shape.period?.description).toContain("churn window");
  });

  it("classifies voluntary and involuntary churn and aggregates reasons", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        subscriptions: {
          list: (params?: Stripe.SubscriptionListParams) => {
            if (params?.status === "active") {
              return createAutoPagedCollection([
                createSubscription({
                  customerId: "cus_active",
                  id: "sub_active",
                  status: "active",
                  unitAmount: 2_000
                })
              ]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>;
            }

            if (params?.status === "canceled") {
              return createAutoPagedCollection([
                createSubscription({
                  canceledAt: 1_745_880_000,
                  cancellation_details: {
                    comment: null,
                    feedback: "too_expensive",
                    reason: "cancellation_requested"
                  },
                  customerId: "cus_voluntary",
                  id: "sub_voluntary",
                  status: "canceled",
                  unitAmount: 1_500
                }),
                createSubscription({
                  canceledAt: 1_745_890_000,
                  cancellation_details: {
                    comment: null,
                    feedback: null,
                    reason: "payment_failed"
                  },
                  customerId: "cus_involuntary",
                  id: "sub_involuntary",
                  status: "canceled",
                  unitAmount: 3_000
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
      records: [],
      truncated: false
    });

    const payload = parsePayload(
      await getChurnSummaryTool.execute(
        {
          period: {
            end: "2025-05-01T00:00:00.000Z",
            start: "2025-04-01T00:00:00.000Z"
          }
        },
        {} as never
      )
    );

    expect(payload.summary.total_churned_count).toBe(2);
    expect(payload.summary.voluntary_count).toBe(1);
    expect(payload.summary.involuntary_count).toBe(1);
    expect(payload.summary.churned_mrr_cents).toBe(4_500);
    expect(payload.items[0]?.reason).toBeTruthy();
  });

  it("propagates failed-payment loader errors", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        subscriptions: {
          list: () => createAutoPagedCollection([]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>
        }
      })
    );
    loadFailedPaymentRecordsMock.mockRejectedValue(new Error("churn support data unavailable"));

    await expect(getChurnSummaryTool.execute({}, {} as never)).rejects.toThrow(
      /churn support data unavailable/
    );
  });
});
