import type Stripe from "stripe";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCustomerProfileTool } from "../../../src/tools/get_customer_profile.js";
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
    created: 1_700_000_000,
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

describe("get_customer_summary", () => {
  beforeEach(() => {
    getStripeClientContextMock.mockReset();
    resolveSingleCustomerMock.mockReset();
    loadCustomerProfileDataMock.mockReset();
  });

  describe("getCustomerProfileTool schema", () => {
    it("validates valid input", () => {
      const validArgs = { customer: "cus_123" };
      expect(() => getCustomerProfileTool.parameters?.parse(validArgs)).not.toThrow();
    });
  });

  it("returns a founder-oriented customer summary", async () => {
    const customer = createCustomer();
    resolveSingleCustomerMock.mockResolvedValue(customer);
    loadCustomerProfileDataMock.mockResolvedValue({
      charges: [{ amount: 2_000, amount_refunded: 0, created: 1_700_000_100, description: "Charge", status: "succeeded" }],
      customer,
      invoices: [{ amount_paid: 2_000, created: 1_700_000_200, description: "Invoice", status: "paid", total: 2_000 }],
      subscriptions: [
        {
          created: 1_700_000_000,
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
                  unit_amount: 1_000
                },
                quantity: 1
              }
            ]
          },
          status: "active"
        }
      ]
    });
    getStripeClientContextMock.mockReturnValue(createMockStripeClientContext({}, "test"));

    const response = (await getCustomerProfileTool.execute({ customer: "alice@example.com" }, {} as never)) as unknown as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(response.content[0]?.text ?? "{}") as {
      items: Array<{ type: string }>;
      summary: { customer_id: string; ltv_cents: number; subscription_status: string | null };
    };

    expect(payload.summary.customer_id).toBe("cus_123");
    expect(payload.summary.ltv_cents).toBe(2_000);
    expect(payload.summary.subscription_status).toBe("active");
    expect(payload.items.length).toBeGreaterThan(0);
  });
});
