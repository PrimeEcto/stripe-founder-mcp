import type Stripe from "stripe";
import { z } from "zod";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { listDisputesTool } from "../../../src/tools/list_disputes.js";
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

function createDispute(
  overrides: Partial<Stripe.Dispute> & {
    amount: number;
    customerEmail: string;
    customerId: string;
    id: string;
    status: Stripe.Dispute.Status;
  }
): Stripe.Dispute {
  const {
    amount,
    customerEmail,
    customerId,
    id,
    status,
    ...rest
  } = overrides;

  return {
    amount,
    charge: {
      amount,
      created: 1_710_000_000,
      currency: "usd",
      customer: {
        created: 1_710_000_000,
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
      id: `${id}_charge`,
      object: "charge",
      status: "succeeded"
    },
    created: 1_710_000_000,
    currency: "usd",
    evidence: {
      customer_email_address: customerEmail
    },
    evidence_details: {
      due_by: 1_710_100_000
    },
    id,
    is_charge_refundable: false,
    livemode: false,
    metadata: {},
    object: "dispute",
    payment_intent: null,
    reason: "fraudulent",
    status,
    ...rest
  } as unknown as Stripe.Dispute;
}

function parsePayload(response: unknown): {
  items: Array<{ dispute_id: string; status: string }>;
  summary: { lost_count_in_period: number; open_count: number; won_count_in_period: number };
} {
  const text = (response as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as {
    items: Array<{ dispute_id: string; status: string }>;
    summary: { lost_count_in_period: number; open_count: number; won_count_in_period: number };
  };
}

describe("list_disputes", () => {
  beforeEach(() => {
    getStripeClientContextMock.mockReset();
  });

  it("defines described optional input fields", () => {
    const parameters = listDisputesTool.parameters;
    const parsed = parameters?.safeParse({
      period: "last_90_days",
      status: "actionable"
    });
    const shape = parameters instanceof z.ZodObject ? parameters.shape : ({} as Record<string, z.ZodTypeAny>);

    expect(parsed?.success).toBe(true);
    expect(shape.period?.description).toContain("dispute window");
    expect(shape.status?.description).toContain("dispute-status filter");
  });

  it("returns only actionable disputes by default while preserving period counts", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        disputes: {
          list: () =>
            createAutoPagedCollection([
              createDispute({
                amount: 2_000,
                customerEmail: "open@example.com",
                customerId: "cus_open",
                id: "dp_open",
                status: "needs_response"
              }),
              createDispute({
                amount: 1_500,
                customerEmail: "won@example.com",
                customerId: "cus_won",
                id: "dp_won",
                status: "won"
              })
            ]) as unknown as Stripe.ApiListPromise<Stripe.Dispute>
        }
      })
    );

    const payload = parsePayload(await listDisputesTool.execute({}, {} as never));

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.dispute_id).toBe("dp_open");
    expect(payload.summary.open_count).toBe(1);
    expect(payload.summary.won_count_in_period).toBe(1);
  });

  it("propagates dispute loader errors", async () => {
    getStripeClientContextMock.mockReturnValue(
      createMockStripeClientContext({
        disputes: {
          list: () => {
            throw new Error("disputes unavailable");
          }
        }
      })
    );

    await expect(listDisputesTool.execute({}, {} as never)).rejects.toThrow(/disputes unavailable/);
  });
});
