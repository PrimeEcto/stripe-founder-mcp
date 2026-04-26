import { describe, expect, it } from "vitest";
import { getMrrTool } from "../../src/tools/get_mrr.js";
import { getIntegrationStripe, hasStripeTestKey } from "./fixtures.js";

const describeIntegration = hasStripeTestKey() ? describe : describe.skip;

describeIntegration("get_mrr integration", () => {
  it("returns current test-mode MRR with trial potential separated out", async () => {
    const response = (await getMrrTool.execute({}, {} as never)) as unknown as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(response.content[0]?.text ?? "{}") as {
      context: {
        caveats: string[];
        stripe_mode: string;
        trialing_subscriptions_count: number;
      };
      summary: {
        mrr_cents: number;
      };
    };

    expect(payload.summary.mrr_cents).toBeGreaterThan(0);
    expect(payload.context.stripe_mode).toBe("test");
    expect(payload.context.trialing_subscriptions_count).toBeGreaterThanOrEqual(1);
    expect(payload.context.caveats[0]).toContain("MRR includes only subscriptions in active or past_due status");
  }, 120_000);

  it("uses a write-capable Stripe test client for fixture seeding", () => {
    expect(getIntegrationStripe()).toBeDefined();
  });
});
