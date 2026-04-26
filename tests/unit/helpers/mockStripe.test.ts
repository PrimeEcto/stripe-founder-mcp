import { describe, expect, it } from "vitest";

import { createAutoPagedCollection, createMockStripeClientContext } from "./mockStripe.js";

describe("mockStripe expand validator", () => {
  it("allows valid depth-4 expands on list-style requests", () => {
    const context = createMockStripeClientContext({
      subscriptions: {
        list: () => createAutoPagedCollection([])
      }
    });

    expect(() =>
      context.stripe.subscriptions.list({
        expand: ["data.items.data.price"]
      })
    ).not.toThrow();
  });

  it("rejects list expands deeper than four levels", () => {
    const context = createMockStripeClientContext({
      subscriptions: {
        list: () => createAutoPagedCollection([])
      }
    });

    expect(() =>
      context.stripe.subscriptions.list({
        expand: ["data.items.data.price.product"]
      })
    ).toThrow(/maximum expand depth of 4/i);
  });

  it("rejects retrieve expands deeper than four levels", () => {
    const context = createMockStripeClientContext({
      subscriptions: {
        retrieve: () => ({ id: "sub_123" })
      }
    });

    expect(() =>
      context.stripe.subscriptions.retrieve("sub_123", {
        expand: ["items.data.price.product.default_price"]
      })
    ).toThrow(/maximum expand depth of 4/i);
  });

  it("rejects event payload object expansion", () => {
    const context = createMockStripeClientContext({
      events: {
        list: () => createAutoPagedCollection([]),
        retrieve: () => ({ id: "evt_123" })
      }
    });

    expect(() =>
      context.stripe.events.list({
        expand: ["data.data.object"]
      })
    ).toThrow(/cannot expand the polymorphic event payload object/i);

    expect(() =>
      context.stripe.events.retrieve("evt_123", {
        expand: ["data.object"]
      })
    ).toThrow(/cannot expand the polymorphic event payload object/i);
  });
});
