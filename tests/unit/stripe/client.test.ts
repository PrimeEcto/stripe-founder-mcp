import Stripe from "stripe";

import {
  createReadOnlyHttpClient,
  createStripeClientContext,
  configureStripeClientContextFromEnvironment,
  detectStripeModeFromKey,
  getStripeClientContext,
  resetStripeClientContextForTests,
  validateStripeApiKey
} from "../../../src/stripe/client.js";

describe("environment-backed stripe context", () => {
  const originalStripeApiKey = process.env.STRIPE_API_KEY;
  const originalCacheTtlSeconds = process.env.CACHE_TTL_SECONDS;
  const originalMaxListResults = process.env.MAX_LIST_RESULTS;

  afterEach(() => {
    resetStripeClientContextForTests();

    if (originalStripeApiKey === undefined) {
      delete process.env.STRIPE_API_KEY;
    } else {
      process.env.STRIPE_API_KEY = originalStripeApiKey;
    }

    if (originalCacheTtlSeconds === undefined) {
      delete process.env.CACHE_TTL_SECONDS;
    } else {
      process.env.CACHE_TTL_SECONDS = originalCacheTtlSeconds;
    }

    if (originalMaxListResults === undefined) {
      delete process.env.MAX_LIST_RESULTS;
    } else {
      process.env.MAX_LIST_RESULTS = originalMaxListResults;
    }
  });

  it("lazily configures from environment on first access", () => {
    process.env.STRIPE_API_KEY = "sk_test_123";
    process.env.CACHE_TTL_SECONDS = "12";
    process.env.MAX_LIST_RESULTS = "34";

    const context = getStripeClientContext();

    expect(context.mode).toBe("test");
    expect(context.cacheTtlSeconds).toBe(12);
    expect(context.maxListResults).toBe(34);
  });

  it("throws a helpful error when tool execution starts without a key", () => {
    delete process.env.STRIPE_API_KEY;

    expect(() => configureStripeClientContextFromEnvironment()).toThrow(
      "STRIPE_API_KEY is required to execute Stripe tools."
    );
  });
});

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
