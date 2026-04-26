import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { normalizeDateRange } from "../lib/dates.js";
import { loadFailedPaymentRecords } from "../lib/failed_payments.js";
import { formatMoney } from "../lib/money.js";
import { executeCachedTool } from "../lib/tool_execution.js";
import type { ToolResult } from "../lib/types.js";
import { getStripeClientContext } from "../stripe/client.js";

const failedPaymentRecoveryRateInputSchema = z.object({
  period: z
    .union([
      z.string(),
      z.object({
        end: z.string().describe("ISO 8601 UTC end timestamp for the dunning measurement window."),
        start: z.string().describe("ISO 8601 UTC start timestamp for the dunning measurement window.")
      })
    ])
    .optional()
    .describe("Optional recovery-rate window. Defaults to last_30_days and accepts ISO ranges, last_30_days, 2026-Q1, or March 2026.")
});

type FailedPaymentRecoveryRateInput = z.infer<typeof failedPaymentRecoveryRateInputSchema>;

interface FailedPaymentRecoveryRateSummary {
  final_failure_count: number;
  recovered_count: number;
  recovered_revenue_cents: number;
  recovered_revenue_formatted: string;
  recovery_rate_pct: number | null;
  still_in_retry_count: number;
  total_failed_count: number;
}

interface FailedPaymentRecoveryRateContext {
  caveats: string[];
  period_label: string;
  stripe_mode: "live" | "test";
  top_unrecovered: Array<{ amount_cents: number; amount_formatted: string; attempted_at_iso: string; customer_email: string | null; failure_message: string | null }>;
  truncated: boolean;
}

type FailedPaymentRecoveryRateResult = ToolResult<
  FailedPaymentRecoveryRateSummary,
  FailedPaymentRecoveryRateContext,
  Record<string, never>
>;

function calculateRecoveryRate(recoveredCount: number, finalFailureCount: number): number | null {
  const completedCount = recoveredCount + finalFailureCount;
  if (completedCount < 3) {
    return null;
  }

  return Number(((recoveredCount / completedCount) * 100).toFixed(2));
}

async function loadFailedPaymentRecoveryRate(
  args: FailedPaymentRecoveryRateInput
): Promise<FailedPaymentRecoveryRateResult> {
  const stripeClient = getStripeClientContext();
  const period = normalizeDateRange(args.period, new Date(), "last_30_days");
  const failedPayments = await loadFailedPaymentRecords(period, "get_failed_payment_recovery_rate:records");

  const recoveredCount = failedPayments.records.filter((record) => record.current_state === "recovered").length;
  const finalFailureCount = failedPayments.records.filter((record) => record.current_state === "final_failure").length;
  const stillInRetryCount = failedPayments.records.filter((record) => record.current_state === "retrying").length;
  const recoveredRevenueCents = failedPayments.records.reduce(
    (total, record) => total + record.recovered_amount_cents,
    0
  );

  const topUnrecovered = failedPayments.records
    .filter((record) => record.current_state !== "recovered")
    .sort((a, b) => b.amount_cents - a.amount_cents)
    .slice(0, 5)
    .map((record) => ({
      amount_cents: record.amount_cents,
      amount_formatted: formatMoney(record.amount_cents, "usd").formatted,
      attempted_at_iso: record.attempted_at_iso,
      customer_email: record.customer_email,
      failure_message: record.failure_message
    }));

  const recoveryRate = calculateRecoveryRate(recoveredCount, finalFailureCount);
  const caveats = [...failedPayments.caveats, "Recovery rate excludes failed payments that are still in retry."];
  if (recoveryRate === null) {
    caveats.push("Recovery rate is null because there are fewer than 3 final outcomes (recovered or final failure) in this period.");
  }

  return {
    context: {
      caveats,
      period_label: period.label,
      stripe_mode: stripeClient.mode,
      top_unrecovered: topUnrecovered,
      truncated: failedPayments.truncated
    },
    items: [],
    summary: {
      final_failure_count: finalFailureCount,
      recovered_count: recoveredCount,
      recovered_revenue_cents: recoveredRevenueCents,
      recovered_revenue_formatted: formatMoney(recoveredRevenueCents, "usd").formatted,
      recovery_rate_pct: recoveryRate,
      still_in_retry_count: stillInRetryCount,
      total_failed_count: failedPayments.records.length
    }
  };
}

export const getFailedPaymentRecoveryRateTool: Tool<
  FastMCPSessionAuth,
  typeof failedPaymentRecoveryRateInputSchema
> = {
  description: "Measure how well failed payments recover over time, excluding attempts that are still in retry.",
  name: "get_failed_payment_recovery_rate",
  parameters: failedPaymentRecoveryRateInputSchema,
  async execute(args) {
    return executeCachedTool("get_failed_payment_recovery_rate", args, async () =>
      loadFailedPaymentRecoveryRate(args)
    );
  }
};
