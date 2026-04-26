import { describe, expect, it } from "vitest";

import { listDisputesTool } from "../../src/tools/list_disputes.js";
import { hasStripeTestKey } from "./fixtures.js";
import { getSharedFixtureSnapshot, parseToolResponse } from "./helpers.js";

const describeIntegration = hasStripeTestKey() ? describe : describe.skip;

describeIntegration("list_disputes integration", () => {
  it("returns the seeded actionable dispute", async () => {
    const fixture = await getSharedFixtureSnapshot();
    const payload = parseToolResponse<{
      items: Array<{ dispute_id: string; status: string }>;
      summary: { open_count: number };
    }>(
      await listDisputesTool.execute(
        {
          period: {
            end: "2100-01-01T00:00:00.000Z",
            start: "2020-01-01T00:00:00.000Z"
          },
          status: "actionable"
        },
        {} as never
      )
    );

    expect(payload.summary.open_count).toBeGreaterThan(0);
    expect(payload.items.some((item) => item.dispute_id === fixture.dispute.id)).toBe(true);
  }, 120_000);
});
