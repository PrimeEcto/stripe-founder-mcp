import { z } from "zod";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getFailedPaymentRecoveryRateTool } from "../../../src/tools/get_failed_payment_recovery_rate.js";
import { createMockStripeClientContext } from "../helpers/mockStripe.js";

const getStripeClientContextMock = vi.fn();
const loadFailedPaymentRecordsMock = vi.fn();

vi.mock("../../../src/stripe/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/stripe/client.js")>(
    "../../../src/stripe/client.js"
  );

  return {
    ...actual,
    getStripeClientContext: () => getStripeClientContextMock()
  };
});

vi.mock("../../../src/lib/failed_payments.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/failed_payments.js")>(
    "../../../src/lib/failed_payments.js"
  );

  return {
    ...actual,
    loadFailedPaymentRecords: (...args: unknown[]) => loadFailedPaymentRecordsMock(...args)
  };
});

function parsePayload(response: unknown): {
  context: { caveats: string[] };
  summary: {
    final_failure_count: number;
    recovered_count: number;
    recovered_revenue_cents: number;
    recovery_rate_pct: number;
    still_in_retry_count: number;
    total_failed_count: number;
  };
} {
  const text = (response as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as {
    context: { caveats: string[] };
    summary: {
      final_failure_count: number;
      recovered_count: number;
      recovered_revenue_cents: number;
      recovery_rate_pct: number;
      still_in_retry_count: number;
      total_failed_count: number;
    };
  };
}

describe("get_failed_payment_recovery_rate", () => {
  beforeEach(() => {
    getStripeClientContextMock.mockReset();
    loadFailedPaymentRecordsMock.mockReset();
  });

  it("defines a described optional period field", () => {
    const parameters = getFailedPaymentRecoveryRateTool.parameters;
    const parsed = parameters?.safeParse({
      period: "last_30_days"
    });
    const shape = parameters instanceof z.ZodObject ? parameters.shape : ({} as Record<string, z.ZodTypeAny>);

    expect(parsed?.success).toBe(true);
    expect(shape.period?.description).toContain("recovery-rate window");
  });

  it("calculates recovery rate excluding retrying failures from the denominator", async () => {
    getStripeClientContextMock.mockReturnValue(createMockStripeClientContext({}));
    loadFailedPaymentRecordsMock.mockResolvedValue({
      caveats: [],
      records: [
        {
          amount_cents: 2_000,
          attempted_at_iso: "2026-04-20T12:00:00.000Z",
          attempt_count: 1,
          customer_email: "ok@example.com",
          customer_id: "cus_ok",
          current_state: "recovered",
          failure_code: "card_declined",
          failure_message: "Declined",
          invoice_id: "in_ok",
          payment_intent_id: "pi_ok",
          recovered_amount_cents: 2_000,
          retry_scheduled_for_iso: null,
          subscription_id: "sub_ok"
        },
        {
          amount_cents: 3_000,
          attempted_at_iso: "2026-04-21T12:00:00.000Z",
          attempt_count: 2,
          customer_email: "lost@example.com",
          customer_id: "cus_lost",
          current_state: "final_failure",
          failure_code: "insufficient_funds",
          failure_message: "No funds",
          invoice_id: "in_lost",
          payment_intent_id: "pi_lost",
          recovered_amount_cents: 0,
          retry_scheduled_for_iso: null,
          subscription_id: "sub_lost"
        },
        {
          amount_cents: 4_000,
          attempted_at_iso: "2026-04-22T12:00:00.000Z",
          attempt_count: 1,
          customer_email: "retry@example.com",
          customer_id: "cus_retry",
          current_state: "retrying",
          failure_code: "card_declined",
          failure_message: "Retrying",
          invoice_id: "in_retry",
          payment_intent_id: "pi_retry",
          recovered_amount_cents: 0,
          retry_scheduled_for_iso: "2026-04-23T12:00:00.000Z",
          subscription_id: "sub_retry"
        },
        {
          amount_cents: 1_000,
          attempt_count: 1,
          attempted_at_iso: "2026-04-23T12:00:00.000Z",
          current_state: "recovered",
          customer_email: "ok2@example.com",
          customer_id: "cus_ok2",
          failure_code: "card_declined",
          failure_message: "Declined",
          invoice_id: "in_ok2",
          payment_intent_id: "pi_ok2",
          recovered_amount_cents: 1_000,
          retry_scheduled_for_iso: null,
          subscription_id: "sub_ok2"
        },
        {
          amount_cents: 1_000,
          attempt_count: 2,
          attempted_at_iso: "2026-04-24T12:00:00.000Z",
          current_state: "final_failure",
          customer_email: "lost2@example.com",
          customer_id: "cus_lost2",
          failure_code: "insufficient_funds",
          failure_message: "No funds",
          invoice_id: "in_lost2",
          payment_intent_id: "pi_lost2",
          recovered_amount_cents: 0,
          retry_scheduled_for_iso: null,
          subscription_id: "sub_lost2"
        }
      ],
      truncated: false
    });

    const payload = parsePayload(await getFailedPaymentRecoveryRateTool.execute({}, {} as never));

    expect(payload.summary.total_failed_count).toBe(5);
    expect(payload.summary.recovered_count).toBe(2);
    expect(payload.summary.final_failure_count).toBe(2);
    expect(payload.summary.still_in_retry_count).toBe(1);
    expect(payload.summary.recovered_revenue_cents).toBe(3_000);
    expect(payload.summary.recovery_rate_pct).toBe(50);
    expect(payload.context.caveats.at(-1)).toContain("still in retry");
  });

  it("propagates failed-payment loader errors", async () => {
    getStripeClientContextMock.mockReturnValue(createMockStripeClientContext({}));
    loadFailedPaymentRecordsMock.mockRejectedValue(new Error("recovery metrics unavailable"));

    await expect(getFailedPaymentRecoveryRateTool.execute({}, {} as never)).rejects.toThrow(
      /recovery metrics unavailable/
    );
  });
});
