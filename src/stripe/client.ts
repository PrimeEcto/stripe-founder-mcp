import Stripe from "stripe";

import type { StripeClientContext, StripeMode, StripeRuntimeOptions } from "../lib/types.js";
import { buildCacheKey, TinyLruCache } from "./cache.js";

const RECOGNIZED_KEY_PREFIXES = [/^rk_(test|live)_/, /^sk_(test|live)_/];

let activeStripeClientContext: StripeClientContext | undefined;

export function detectStripeModeFromKey(apiKey: string): StripeMode {
  if (apiKey.startsWith("rk_test_") || apiKey.startsWith("sk_test_")) {
    return "test";
  }

  if (apiKey.startsWith("rk_live_") || apiKey.startsWith("sk_live_")) {
    return "live";
  }

  throw new Error("STRIPE_API_KEY must begin with rk_test_, rk_live_, sk_test_, or sk_live_.");
}

export function validateStripeApiKey(apiKey: string): void {
  const isRecognized = RECOGNIZED_KEY_PREFIXES.some((pattern) => pattern.test(apiKey));
  if (!isRecognized) {
    throw new Error("Unsupported STRIPE_API_KEY prefix. Use a Stripe restricted or secret key.");
  }
}

export function createReadOnlyHttpClient(
  inner: Stripe.StripeConfig["httpClient"] = Stripe.createNodeHttpClient()
): Stripe.HttpClient {
  if (!inner) {
    throw new Error("A base Stripe HTTP client is required.");
  }

  return {
    getClientName(): string {
      return `${inner.getClientName()}:read-only`;
    },
    async makeRequest(host, port, path, method, headers, requestData, protocol, timeout) {
      if (method !== "GET") {
        throw new Error(`Read-only Stripe client blocked ${method} ${path}.`);
      }

      return inner.makeRequest(host, port, path, method, headers, requestData, protocol, timeout);
    }
  };
}

export function createStripeClientContext(options: StripeRuntimeOptions): StripeClientContext {
  validateStripeApiKey(options.apiKey);

  const mode = detectStripeModeFromKey(options.apiKey);
  const cache = options.cacheTtlSeconds > 0 ? new TinyLruCache<unknown>() : undefined;
  const stripe = new Stripe(options.apiKey, {
    appInfo: {
      name: "stripe-founder-mcp",
      url: "https://github.com/stripe-founder-mcp/stripe-founder-mcp",
      version: "0.1.0"
    },
    httpClient: createReadOnlyHttpClient(),
    maxNetworkRetries: 0
  });

  return {
    cacheTtlSeconds: options.cacheTtlSeconds,
    async getCachedToolResult<T>(toolName: string, args: unknown, loader: () => Promise<T>): Promise<T> {
      if (!cache) {
        return loader();
      }

      const key = buildCacheKey(toolName, args);
      const cached = cache.get(key) as T | undefined;
      if (cached !== undefined) {
        return cached;
      }

      const loaded = await loader();
      cache.set(key, loaded, options.cacheTtlSeconds);
      return loaded;
    },
    maxListResults: options.maxListResults,
    mode,
    stripe
  };
}

export function configureStripeClientContext(options: StripeRuntimeOptions): StripeClientContext {
  activeStripeClientContext = createStripeClientContext(options);
  return activeStripeClientContext;
}

export function getStripeClientContext(): StripeClientContext {
  if (!activeStripeClientContext) {
    throw new Error("Stripe client context has not been configured.");
  }

  return activeStripeClientContext;
}

export function resetStripeClientContextForTests(): void {
  activeStripeClientContext = undefined;
}
