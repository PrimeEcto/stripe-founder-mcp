import { describe, expect, it } from "vitest";

import { getChurnSummaryTool } from "../../src/tools/get_churn_summary.js";
import { hasStripeTestKey } from "./fixtures.js";
import { getSharedFixtureSnapshot, parseToolResponse } from "./helpers.js";

const describeIntegration = hasStripeTestKey() ? describe : describe.skip;

describeIntegration("get_churn_summary integration", () => {
  it("returns the seeded canceled subscription and its cancellation feedback", async () => {
    await getSharedFixtureSnapshot();
    const payload = parseToolResponse<{
      items: Array<{ count: number; reason: string }>;
      summary: { total_churned_count: number };
    }>(
      await getChurnSummaryTool.execute(
        {
          period: {
            end: "2100-01-01T00:00:00.000Z",
            start: "2020-01-01T00:00:00.000Z"
          }
        },
        {} as never
      )
    );

    expect(payload.summary.total_churned_count).toBeGreaterThanOrEqual(1);
    expect(payload.items.some((item) => item.reason === "too_expensive")).toBe(true);
  }, 120_000);
});
