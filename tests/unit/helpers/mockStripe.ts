import type { StripeClientContext, StripeMode } from "../../../src/lib/types.js";

export type MockStripe = Record<string, unknown>;
type MockStripeMethodName = "list" | "retrieve" | "search";

const VALIDATED_METHODS = new Set<MockStripeMethodName>(["list", "retrieve", "search"]);

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateExpandPath(
  endpointPath: string[],
  methodName: MockStripeMethodName,
  expandPath: string
): void {
  const segments = expandPath.split(".");
  if (segments.length > 4) {
    throw new Error(
      `Mock Stripe expand validation failed for ${endpointPath.join(".")}.${methodName}(): "${expandPath}" exceeds Stripe's maximum expand depth of 4.`
    );
  }

  if (endpointPath.join(".") !== "events") {
    return;
  }

  const normalizedSegments =
    methodName === "list" && segments[0] === "data" ? segments.slice(1) : segments;

  if (normalizedSegments[0] === "data" && normalizedSegments[1] === "object") {
    throw new Error(
      `Mock Stripe expand validation failed for ${endpointPath.join(".")}.${methodName}(): "${expandPath}" cannot expand the polymorphic event payload object.`
    );
  }
}

function validateExpandOptions(
  endpointPath: string[],
  methodName: MockStripeMethodName,
  args: unknown[]
): void {
  const optionsIndex = methodName === "retrieve" ? 1 : 0;
  const options = args[optionsIndex];
  if (!isObjectLike(options) || !Array.isArray(options.expand)) {
    return;
  }

  for (const expandPath of options.expand) {
    if (typeof expandPath !== "string") {
      continue;
    }

    validateExpandPath(endpointPath, methodName, expandPath);
  }
}

function wrapMockStripeValue(value: unknown, path: string[] = []): unknown {
  if (typeof value === "function") {
    const methodName = path.at(-1);
    if (!methodName || !VALIDATED_METHODS.has(methodName as MockStripeMethodName)) {
      return value;
    }

    const endpointPath = path.slice(0, -1);
    const original = value;

    return (...args: unknown[]) => {
      validateExpandOptions(endpointPath, methodName as MockStripeMethodName, args);
      return original(...args);
    };
  }

  if (!isObjectLike(value) || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, wrapMockStripeValue(child, [...path, key])])
  );
}

export function createAutoPagedCollection<T>(values: T[]) {
  return {
    async autoPagingEach(handler: (item: T) => boolean | void | Promise<boolean | void>): Promise<void> {
      for (const value of values) {
        const shouldContinue = await handler(value);
        if (shouldContinue === false) {
          return;
        }
      }
    }
  };
}

export function createMockStripeClientContext(
  stripe: MockStripe,
  mode: StripeMode = "test"
): StripeClientContext {
  return {
    cacheTtlSeconds: 60,
    async getCachedToolResult<T>(_toolName: string, _args: unknown, loader: () => Promise<T>): Promise<T> {
      return loader();
    },
    maxListResults: 1000,
    mode,
    stripe: wrapMockStripeValue(stripe) as StripeClientContext["stripe"]
  };
}
