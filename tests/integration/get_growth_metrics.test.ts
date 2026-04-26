import { describe, expect, it } from "vitest";

import { getGrowthMetricsTool } from "../../src/tools/get_growth_metrics.js";
import { hasStripeTestKey } from "./fixtures.js";
import { parseToolResponse } from "./helpers.js";

const describeIntegration = hasStripeTestKey() ? describe : describe.skip;

describeIntegration("get_growth_metrics integration", () => {
  it("returns founder growth metrics for the seeded fixture period", async () => {
    const response = await getGrowthMetricsTool.execute(
      {
        period: "last_30_days"
      },
      {} as never
    );
    const payload = parseToolResponse<{
      context: { stripe_mode: string };
      summary: { mrr_end_cents: number; net_new_mrr: number };
    }>(response);

    expect(payload.context.stripe_mode).toBe("test");
    expect(payload.summary.mrr_end_cents).toBeGreaterThanOrEqual(0);
    expect(typeof payload.summary.net_new_mrr).toBe("number");
  }, 120_000);
});
