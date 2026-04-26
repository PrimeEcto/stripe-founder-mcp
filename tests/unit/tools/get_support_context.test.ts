import type Stripe from "stripe";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSupportContextTool } from "../../../src/tools/get_support_context.js";
import { createMockStripeClientContext } from "../helpers/mockStripe.js";

const getStripeClientContextMock = vi.fn();
const resolveSingleCustomerMock = vi.fn();
const loadCustomerProfileDataMock = vi.fn();

vi.mock("../../../src/stripe/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/stripe/client.js")>(
    "../../../src/stripe/client.js"
  );

  return {
    ...actual,
    getStripeClientContext: () => getStripeClientContextMock()
  };
});

vi.mock("../../../src/lib/customer_lookup.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/customer_lookup.js")>(
    "../../../src/lib/customer_lookup.js"
  );

  return {
    ...actual,
    resolveSingleCustomer: (...args: unknown[]) => resolveSingleCustomerMock(...args)
  };
});

vi.mock("../../../src/lib/customer_profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/customer_profiles.js")>(
    "../../../src/lib/customer_profiles.js"
  );

  return {
    ...actual,
    loadCustomerProfileData: (...args: unknown[]) => loadCustomerProfileDataMock(...args)
  };
});

function createCustomer(): Stripe.Customer {
  return {
    created: Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60,
    currency: "usd",
    email: "alice@example.com",
    id: "cus_123",
    invoice_settings: {
      custom_fields: null,
      default_payment_method: {
        card: {
          last4: "4242"
        },
        id: "pm_123",
        object: "payment_method",
        type: "card"
      },
      footer: null,
      rendering_options: null
    },
    metadata: {},
    name: "Alice",
    object: "customer"
  } as unknown as Stripe.Customer;
}

describe("summarize_customer_for_support", () => {
  beforeEach(() => {
    getStripeClientContextMock.mockReset();
    resolveSingleCustomerMock.mockReset();
    loadCustomerProfileDataMock.mockReset();
  });

  describe("getSupportContextTool schema", () => {
    it("validates valid input", () => {
      const validArgs = { context_hint: "refund issue", customer: "cus_123" };
      expect(() => getSupportContextTool.parameters?.parse(validArgs)).not.toThrow();
    });
  });

  it("returns support flags and refund-eligible charges", async () => {
    const customer = createCustomer();
    resolveSingleCustomerMock.mockResolvedValue(customer);
    loadCustomerProfileDataMock.mockResolvedValue({
      charges: [
        { amount: 12_000, amount_refunded: 0, created: Math.floor(Date.now() / 1000) - 100, disputed: true, status: "succeeded" }
      ],
      customer,
      invoices: [],
      subscriptions: [
        {
          created: Math.floor(Date.now() / 1000) - 1000,
          customer: customer.id,
          id: "sub_123",
          items: {
            data: [
              {
                price: {
                  id: "price_123",
                  nickname: "Pro",
                  product: "prod_123",
                  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
                  unit_amount: 3_000
                },
                quantity: 1
              }
            ]
          },
          status: "past_due"
        }
      ]
    });
    getStripeClientContextMock.mockReturnValue(createMockStripeClientContext({}, "test"));

    const response = (await getSupportContextTool.execute(
      { context_hint: "refund request", customer: "alice@example.com" },
      {} as never
    )) as unknown as { content: Array<{ text: string }> };
    const payload = JSON.parse(response.content[0]?.text ?? "{}") as {
      context: { refund_eligible_charges: Array<{ charge_id: string }> };
      summary: { flags: string[] };
    };

    expect(payload.summary.flags).toContain("in_dunning");
    expect(payload.summary.flags).toContain("recent_dispute");
    expect(payload.summary.flags).toContain("high_value");
    expect(payload.context.refund_eligible_charges.length).toBeGreaterThan(0);
  });
});
