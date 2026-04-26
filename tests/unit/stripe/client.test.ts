import Stripe from "stripe";

import {
  createReadOnlyHttpClient,
  createStripeClientContext,
  detectStripeModeFromKey,
  validateStripeApiKey
} from "../../../src/stripe/client.js";

describe("validateStripeApiKey", () => {
  it("accepts restricted and secret Stripe keys", () => {
    expect(() => validateStripeApiKey("rk_test_123")).not.toThrow();
    expect(() => validateStripeApiKey("sk_live_123")).not.toThrow();
  });

  it("rejects unknown prefixes", () => {
    expect(() => validateStripeApiKey("pk_test_123")).toThrow(/Unsupported STRIPE_API_KEY prefix/);
  });
});

describe("detectStripeModeFromKey", () => {
  it("detects test and live modes", () => {
    expect(detectStripeModeFromKey("rk_test_123")).toBe("test");
    expect(detectStripeModeFromKey("sk_live_123")).toBe("live");
  });
});

describe("createReadOnlyHttpClient", () => {
  it("throws on non-GET requests", async () => {
    const inner: Stripe.HttpClient = {
      getClientName: () => "inner",
      async makeRequest() {
        throw new Error("should not be called");
      }
    };

    const client = createReadOnlyHttpClient(inner);

    await expect(
      client.makeRequest("api.stripe.com", 443, "/v1/customers", "POST", {}, null, "https", 30_000)
    ).rejects.toThrow(/blocked POST/i);
  });

  it("passes GET requests through to the base client", async () => {
    const response = {
      getHeaders: () => ({}),
      getRawResponse: () => ({}),
      getStatusCode: () => 200,
      toJSON: async () => ({ ok: true }),
      toStream: () => ({})
    };
    const inner: Stripe.HttpClient = {
      getClientName: () => "inner",
      async makeRequest() {
        return response;
      }
    };

    const client = createReadOnlyHttpClient(inner);

    await expect(
      client.makeRequest("api.stripe.com", 443, "/v1/customers", "GET", {}, null, "https", 30_000)
    ).resolves.toBe(response);
  });
});

describe("createStripeClientContext", () => {
  it("creates a test-mode context", () => {
    const context = createStripeClientContext({
      apiKey: "sk_test_123",
      cacheTtlSeconds: 60,
      maxListResults: 1000
    });

    expect(context.mode).toBe("test");
    expect(typeof context.getCachedToolResult).toBe("function");
  });

  it("disables cache when ttl is zero", async () => {
    const context = createStripeClientContext({
      apiKey: "sk_test_123",
      cacheTtlSeconds: 0,
      maxListResults: 1000
    });

    let calls = 0;
    const loader = async (): Promise<number> => {
      calls += 1;
      return calls;
    };

    expect(await context.getCachedToolResult("tool", {}, loader)).toBe(1);
    expect(await context.getCachedToolResult("tool", {}, loader)).toBe(2);
  });
});
