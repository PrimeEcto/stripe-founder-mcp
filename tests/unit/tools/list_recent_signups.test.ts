import type Stripe from "stripe";
import { z } from "zod";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { listRecentSignupsTool } from "../../../src/tools/list_recent_signups.js";
import { createAutoPagedCollection, createMockStripeClientContext } from "../helpers/mockStripe.js";

const getStripeClientContextMock = vi.fn();

vi.mock("../../../src/stripe/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/stripe/client.js")>(
    "../../../src/stripe/client.js"
  );

  return {
    ...actual,
    getStripeClientContext: () => getStripeClientContextMock()
  };
});

function createCustomer(overrides: Partial<Stripe.Customer> & { created: number; email: string; id: string }): Stripe.Customer {
  const {
    created,
    email,
    id,
    ...rest
  } = overrides;

  return {
    created,
    email,
    id,
    invoice_settings: {
      custom_fields: null,
      default_payment_method: null,
      footer: null,
      rendering_options: null
    },
    metadata: {},
    name: email,
    object: "customer",
    ...rest
  } as unknown as Stripe.Customer;
}

function createPaymentMethod(): Stripe.PaymentMethod {
  return {
    billing_details: {
      address: null,
      email: null,
      name: null,
      phone: null
    },
    created: 1_710_000_000,
    customer: null,
    id: "pm_card",
    livemode: false,
    metadata: {},
    object: "payment_method",
    type: "card"
  } as unknown as Stripe.PaymentMethod;
}

function createSubscription(
  overrides: Partial<Stripe.Subscription> & {
    customerId: string;
    id: string;
    status: Stripe.Subscription.Status;
    unitAmount: number;
  }
): Stripe.Subscription {
  const {
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
    customer: customerId,
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
    trial_end: status === "trialing" ? 1_900_000_000 : null,
    ...rest
  } as unknown as Stripe.Subscription;
}

function parsePayload(response: unknown): {
  items: Array<{ customer_id: string; mrr_cents: number }>;
  summary: { paid_signup_count: number; signup_count: number; total_new_mrr_cents: number };
} {
  const text = (response as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as {
    items: Array<{ customer_id: string; mrr_cents: number }>;
    summary: { paid_signup_count: number; signup_count: number; total_new_mrr_cents: number };
  };
}

describe("list_recent_signups", () => {
  beforeEach(() => {
    getStripeClientContextMock.mockReset();
  });

  it("defines described optional input fields", () => {
    const parameters = listRecentSignupsTool.parameters;
    const parsed = parameters?.safeParse({
      limit: 10,
      min_mrr_cents: 500,
      period: "last_7_days"
    });
    const shape = parameters instanceof z.ZodObject ? parameters.shape : ({} as Record<string, z.ZodTypeAny>);

    expect(parsed?.success).toBe(true);
    expect(shape.period?.description).toContain("signup window");
    expect(shape.min_mrr_cents?.description).toContain("minimum current MRR");
  });

  it("counts trialing customers as signups but not as new MRR", async () => {
    const customers = [
      createCustomer({
        created: 1_710_000_300,
        email: "active@example.com",
        id: "cus_active",
        invoice_settings: {
          custom_fields: null,
          default_payment_method: createPaymentMethod(),
          footer: null,
          rendering_options: null
        }
      }),
      createCustomer({
        created: 1_710_000_200,
        email: "trial@example.com",
        id: "cus_trial"
      }),
      createCustomer({
        created: 1_710_000_100,
        email: "free@example.com",
        id: "cus_free"
      })
    ];

    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        customers: {
          list: () => createAutoPagedCollection(customers) as unknown as Stripe.ApiListPromise<Stripe.Customer>
        },
        subscriptions: {
          list: ({ customer }: { customer: string }) => {
            if (customer === "cus_active") {
              return createAutoPagedCollection([
                createSubscription({
                  customerId: customer,
                  id: "sub_active",
                  status: "active",
                  unitAmount: 1_500
                })
              ]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>;
            }

            if (customer === "cus_trial") {
              return createAutoPagedCollection([
                createSubscription({
                  customerId: customer,
                  id: "sub_trial",
                  status: "trialing",
                  unitAmount: 900
                })
              ]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>;
            }

            return createAutoPagedCollection([]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>;
          }
        }
      })
    );

    const payload = parsePayload(await listRecentSignupsTool.execute({}, {} as never));

    expect(payload.summary.signup_count).toBe(3);
    expect(payload.summary.paid_signup_count).toBe(1);
    expect(payload.summary.total_new_mrr_cents).toBe(1_500);
    expect(payload.items.find((item) => item.customer_id === "cus_trial")?.mrr_cents).toBe(0);
  });

  it("propagates subscription loader errors", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        customers: {
          list: () =>
            createAutoPagedCollection([
              createCustomer({
                created: 1_710_000_300,
                email: "broken@example.com",
                id: "cus_broken"
              })
            ]) as unknown as Stripe.ApiListPromise<Stripe.Customer>
        },
        subscriptions: {
          list: () => {
            throw new Error("subscriptions unavailable");
          }
        }
      })
    );

    await expect(listRecentSignupsTool.execute({}, {} as never)).rejects.toThrow(/subscriptions unavailable/);
  });
});
