import type Stripe from "stripe";
import { z } from "zod";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getMrrTool } from "../../../src/tools/get_mrr.js";
import { createAutoPagedCollection, createMockStripeClientContext } from "../helpers/mockStripe.js";

const getStripeClientContextMock = vi.fn();
type GetMrrArgs = {
  as_of?: string;
  compare_to?: string;
};

vi.mock("../../../src/stripe/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/stripe/client.js")>(
    "../../../src/stripe/client.js"
  );

  return {
    ...actual,
    getStripeClientContext: () => getStripeClientContextMock()
  };
});

function createSubscription(
  overrides: Partial<Stripe.Subscription> & {
    created: number;
    id: string;
    priceId: string;
    status: Stripe.Subscription.Status;
    unitAmount: number;
  }
): Stripe.Subscription {
  const {
    created,
    id,
    priceId,
    status,
    unitAmount,
    ...rest
  } = overrides;

  return {
    cancel_at: null,
    canceled_at: rest.canceled_at ?? null,
    currency: "usd",
    customer: "cus_test",
    ended_at: rest.ended_at ?? null,
    id,
    items: {
      data: [
        {
          id: `${id}_item`,
          object: "subscription_item",
          price: {
            currency: "usd",
            id: priceId,
            nickname: priceId,
            object: "price",
            product: priceId,
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
    trial_end: rest.trial_end ?? null,
    ...rest,
    created
  } as unknown as Stripe.Subscription;
}

async function executeGetMrr(args: GetMrrArgs): Promise<{
  context: {
    potential_mrr_from_trials_cents: number;
    trialing_subscriptions_count: number;
  };
  summary: {
    active_subscriptions_count: number;
    mrr_cents: number;
  };
}> {
  const response = (await getMrrTool.execute(args, {} as never)) as unknown as {
    content: Array<{ text: string }>;
  };
  const text = response.content[0]?.text;
  return JSON.parse(text ?? "{}") as {
    context: {
      potential_mrr_from_trials_cents: number;
      trialing_subscriptions_count: number;
    };
    summary: {
      active_subscriptions_count: number;
      mrr_cents: number;
    };
  };
}

describe("get_mrr", () => {
  beforeEach(() => {
    getStripeClientContextMock.mockReset();
  });

  it("defines described optional input fields", () => {
    const parameters = getMrrTool.parameters;
    const parsed = parameters?.safeParse({
      as_of: "2026-04-26T00:00:00.000Z",
      compare_to: "last_month"
    });
    const shape = parameters instanceof z.ZodObject ? parameters.shape : ({} as Record<string, z.ZodTypeAny>);

    expect(parsed?.success).toBe(true);
    expect(shape.as_of?.description).toContain("Optional ISO date");
    expect(shape.compare_to?.description).toContain("comparison");
  });

  it("returns headline MRR without counting trialing subscriptions", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        subscriptions: {
          list: () =>
            createAutoPagedCollection([
              createSubscription({
                created: 1_700_000_000,
                id: "sub_active",
                priceId: "price_basic",
                status: "active",
                unitAmount: 1_000
              }),
              createSubscription({
                created: 1_700_000_100,
                id: "sub_past_due",
                priceId: "price_pro",
                status: "past_due",
                unitAmount: 2_000
              }),
              createSubscription({
                created: 1_700_000_200,
                id: "sub_trial",
                priceId: "price_trial",
                status: "trialing",
                trial_end: 1_900_000_000,
                unitAmount: 500
              })
            ]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>
        }
      })
    );

    const parsed = await executeGetMrr({});

    expect(parsed.summary.mrr_cents).toBe(3_000);
    expect(parsed.summary.active_subscriptions_count).toBe(1);
    expect(parsed.context.trialing_subscriptions_count).toBe(1);
    expect(parsed.context.potential_mrr_from_trials_cents).toBe(500);
  });

  it("returns an error for unsupported date inputs", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        subscriptions: {
          list: () => createAutoPagedCollection([]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>
        }
      })
    );

    await expect(getMrrTool.execute({ compare_to: "not-a-real-range" }, {} as never)).rejects.toThrow(
      /Unsupported date range input/
    );
  });
});
