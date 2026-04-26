import { describe, expect, it } from "vitest";

import { listAtRiskCustomersTool } from "../../src/tools/list_at_risk_customers.js";
import { hasStripeTestKey } from "./fixtures.js";
import { getSharedFixtureSnapshot, parseToolResponse } from "./helpers.js";

const describeIntegration = hasStripeTestKey() ? describe : describe.skip;

describeIntegration("list_at_risk_customers integration", () => {
  it("returns past-due and failed-payment risk rows in Stripe test mode", async () => {
    const fixture = await getSharedFixtureSnapshot();
    const payload = parseToolResponse<{
      context: { stripe_mode: string };
      items: Array<{ customer_id: string; risk_signal: string }>;
      summary: { total_mrr_at_risk_cents: number };
    }>(await listAtRiskCustomersTool.execute({}, {} as never));

    expect(payload.context.stripe_mode).toBe("test");
    expect(payload.summary.total_mrr_at_risk_cents).toBeGreaterThan(0);
    expect(
      payload.items.some(
        (item) => item.customer_id === fixture.customers.pastDue.id && item.risk_signal === "past_due"
      )
    ).toBe(true);
  }, 120_000);
});
