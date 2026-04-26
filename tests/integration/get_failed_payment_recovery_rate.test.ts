import { describe, expect, it } from "vitest";

import { getFailedPaymentRecoveryRateTool } from "../../src/tools/get_failed_payment_recovery_rate.js";
import { hasStripeTestKey } from "./fixtures.js";
import { parseToolResponse } from "./helpers.js";

const describeIntegration = hasStripeTestKey() ? describe : describe.skip;

describeIntegration("get_failed_payment_recovery_rate integration", () => {
  it("returns recovery metrics for recent failed payments", async () => {
    const payload = parseToolResponse<{
      context: { caveats: string[] };
      summary: {
        recovered_count: number;
        recovery_rate_pct: number;
        total_failed_count: number;
      };
    }>(await getFailedPaymentRecoveryRateTool.execute({ period: "last_30_days" }, {} as never));

    expect(payload.summary.total_failed_count).toBeGreaterThan(0);
    expect(payload.summary.recovery_rate_pct).toBeGreaterThanOrEqual(0);
    expect(payload.summary.recovered_count).toBeGreaterThanOrEqual(0);
    expect(payload.context.caveats.some((caveat) => caveat.includes("still in retry"))).toBe(true);
  }, 120_000);
});
