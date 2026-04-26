import type Stripe from "stripe";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getGrowthMetricsTool } from "../../../src/tools/get_growth_metrics.js";
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

function createSubscription(
  overrides: Partial<Stripe.Subscription> & {
    created: number;
    id: string;
    status: Stripe.Subscription.Status;
    unitAmount: number;
  }
): Stripe.Subscription {
  const { created, id, status, unitAmount, ...rest } = overrides;

  return {
    canceled_at: rest.canceled_at ?? null,
    created,
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
            id: `${id}_price`,
            nickname: `${id}_price`,
            object: "price",
            product: `${id}_product`,
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
    status,
    trial_end: rest.trial_end ?? null,
    ...rest
  } as unknown as Stripe.Subscription;
}

describe("get_growth_metrics", () => {
  beforeEach(() => {
    getStripeClientContextMock.mockReset();
  });

  it("parses the optional period input", () => {
    const parsed = getGrowthMetricsTool.parameters?.safeParse({
      period: "this_month"
    });

    expect(parsed?.success).toBe(true);
  });

  it("returns growth metrics from subscription snapshots", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        subscriptions: {
          list: () =>
            createAutoPagedCollection([
              createSubscription({
                created: 1_742_409_600,
                id: "sub_existing",
                status: "active",
                unitAmount: 2_000
              }),
              createSubscription({
                created: 1_743_724_800,
                id: "sub_new",
                status: "active",
                unitAmount: 1_000
              }),
              createSubscription({
                canceled_at: 1_743_811_200,
                created: 1_742_409_600,
                id: "sub_churned",
                status: "canceled",
                unitAmount: 500
              }),
              createSubscription({
                created: 1_743_724_800,
                id: "sub_trial",
                status: "trialing",
                trial_end: 1_900_000_000,
                unitAmount: 700
              })
            ]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>
        }
      })
    );

    const response = (await getGrowthMetricsTool.execute(
      { period: { end: "2025-04-10T00:00:00.000Z", start: "2025-04-01T00:00:00.000Z" } },
      {} as never
    )) as unknown as { content: Array<{ text: string }> };
    const payload = JSON.parse(response.content[0]?.text ?? "{}") as {
      summary: { churned_mrr: number; mrr_end_cents: number; new_mrr: number };
    };

    expect(payload.summary.new_mrr).toBe(1_000);
    expect(payload.summary.churned_mrr).toBe(500);
    expect(payload.summary.mrr_end_cents).toBeGreaterThan(0);
  });

  it("throws on invalid period input", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        subscriptions: {
          list: () => createAutoPagedCollection([]) as unknown as Stripe.ApiListPromise<Stripe.Subscription>
        }
      })
    );

    await expect(getGrowthMetricsTool.execute({ period: "bad-period" }, {} as never)).rejects.toThrow(
      /Unsupported date range input/
    );
  });
});
