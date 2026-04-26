import { describe, expect, it } from "vitest";

import { listRecentSignupsTool } from "../../src/tools/list_recent_signups.js";
import { hasStripeTestKey } from "./fixtures.js";
import { getSharedFixtureSnapshot, parseToolResponse } from "./helpers.js";

const describeIntegration = hasStripeTestKey() ? describe : describe.skip;

describeIntegration("list_recent_signups integration", () => {
  it("lists seeded customers and keeps trialing signups out of total new MRR", async () => {
    const fixture = await getSharedFixtureSnapshot();
    const payload = parseToolResponse<{
      items: Array<{ customer_id: string; mrr_cents: number }>;
      summary: { signup_count: number; total_new_mrr_cents: number };
    }>(
      await listRecentSignupsTool.execute(
        {
          period: {
            end: "2100-01-01T00:00:00.000Z",
            start: "2020-01-01T00:00:00.000Z"
          }
        },
        {} as never
      )
    );

    expect(payload.summary.signup_count).toBeGreaterThanOrEqual(5);
    expect(payload.items.some((item) => item.customer_id === fixture.customers.activeBasic.id)).toBe(true);
    expect(payload.items.find((item) => item.customer_id === fixture.customers.trialing.id)?.mrr_cents).toBe(0);
    expect(payload.summary.total_new_mrr_cents).toBeGreaterThan(0);
  }, 120_000);
});
