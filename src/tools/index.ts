import type { FastMCPSessionAuth, Tool } from "fastmcp";
import type { ZodTypeAny } from "zod";

import { getChurnSummaryTool } from "./get_churn_summary.js";
import { getCustomerProfileTool } from "./get_customer_profile.js";
import { getFailedPaymentRecoveryRateTool } from "./get_failed_payment_recovery_rate.js";
import { getGrowthMetricsTool } from "./get_growth_metrics.js";
import { getMrrTool } from "./get_mrr.js";
import { getSupportContextTool } from "./get_support_context.js";
import { listAtRiskCustomersTool } from "./list_at_risk_customers.js";
import { listDisputesTool } from "./list_disputes.js";
import { listRecentSignupsTool } from "./list_recent_signups.js";

export const tools = [
  getMrrTool,
  getGrowthMetricsTool,
  getChurnSummaryTool,
  getCustomerProfileTool,
  getFailedPaymentRecoveryRateTool,
  listAtRiskCustomersTool,
  listDisputesTool,
  listRecentSignupsTool,
  getSupportContextTool
] as unknown as Array<
  Tool<FastMCPSessionAuth, ZodTypeAny>
>;
