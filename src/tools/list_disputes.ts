import type { FastMCPSessionAuth, Tool } from "fastmcp";
import type Stripe from "stripe";
import { z } from "zod";

import { normalizeDateRange } from "../lib/dates.js";
import { createdToIso, customerEmailFromExpandable, customerIdFromExpandable } from "../lib/stripe_records.js";
import { executeCachedTool } from "../lib/tool_execution.js";
import type { ToolResult } from "../lib/types.js";
import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

const ACTIONABLE_DISPUTE_STATUSES = new Set<Stripe.Dispute.Status>(["needs_response", "warning_needs_response"]);
const OPEN_DISPUTE_STATUSES = new Set<Stripe.Dispute.Status>([
  "needs_response",
  "under_review",
  "warning_needs_response",
  "warning_under_review"
]);

const listDisputesInputSchema = z.object({
  period: z
    .union([
      z.string(),
      z.object({
        end: z.string().describe("ISO 8601 UTC end timestamp for the dispute window."),
        start: z.string().describe("ISO 8601 UTC start timestamp for the dispute window.")
      })
    ])
    .optional()
    .describe("Optional dispute window. Defaults to last_90_days and accepts ISO ranges, last_30_days, 2026-Q1, or March 2026."),
  status: z
    .enum(["actionable", "all", "lost", "won"])
    .optional()
    .describe("Optional dispute-status filter. actionable returns disputes waiting on action, while won and lost return only closed outcomes.")
});

type ListDisputesInput = z.infer<typeof listDisputesInputSchema>;

interface ListDisputesSummary {
  total_disputed_amount_cents: number;
  open_count: number;
  won_count_in_period: number;
  lost_count_in_period: number;
  nearest_evidence_due_by_iso: string | null;
  nearest_evidence_due_dispute_id: string | null;
}

interface ListDisputesContext {
  period_label: string;
  status_filter: "actionable" | "all" | "lost" | "won";
  stripe_mode: "live" | "test";
  truncated: boolean;
}

interface ListDisputesItem {
  amount_cents: number;
  created_iso: string | null;
  customer_email: string | null;
  customer_id: string | null;
  dispute_id: string;
  evidence_due_by_iso: string | null;
  reason: string;
  status: Stripe.Dispute.Status;
}

type ListDisputesResult = ToolResult<ListDisputesSummary, ListDisputesContext, ListDisputesItem>;

function getDisputeCustomer(dispute: Stripe.Dispute): { customer_email: string | null; customer_id: string | null } {
  const paymentIntent = dispute.payment_intent;
  if (paymentIntent && typeof paymentIntent !== "string") {
    return {
      customer_email: customerEmailFromExpandable(paymentIntent.customer),
      customer_id: customerIdFromExpandable(paymentIntent.customer) ?? null
    };
  }

  const charge = dispute.charge;
  if (charge && typeof charge !== "string") {
    return {
      customer_email: customerEmailFromExpandable(charge.customer),
      customer_id: customerIdFromExpandable(charge.customer) ?? null
    };
  }

  return {
    customer_email: dispute.evidence?.customer_email_address ?? null,
    customer_id: null
  };
}

function matchesStatusFilter(dispute: Stripe.Dispute, statusFilter: ListDisputesInput["status"]): boolean {
  if (!statusFilter || statusFilter === "all") {
    return true;
  }

  if (statusFilter === "actionable") {
    return ACTIONABLE_DISPUTE_STATUSES.has(dispute.status);
  }

  return dispute.status === statusFilter;
}

async function loadDisputes(args: ListDisputesInput): Promise<ListDisputesResult> {
  const stripeClient = getStripeClientContext();
  const period = normalizeDateRange(args.period, new Date(), "last_90_days");
  const statusFilter = args.status ?? "actionable";

  const disputes = await stripeClient.getCachedToolResult("list_disputes:disputes", args, async () =>
    collectAutoPaged(
      stripeClient.stripe.disputes.list({
        created: {
          gte: Math.floor(period.start.getTime() / 1000),
          lt: Math.floor(period.end.getTime() / 1000)
        },
        expand: ["data.charge.customer", "data.payment_intent.customer"],
        limit: 100
      }),
      stripeClient.maxListResults
    )
  );

  const filtered = disputes.items.filter((dispute) => matchesStatusFilter(dispute, statusFilter));
  const items = filtered.map((dispute) => {
    const customer = getDisputeCustomer(dispute);
    return {
      amount_cents: dispute.amount,
      created_iso: createdToIso(dispute.created),
      customer_email: customer.customer_email,
      customer_id: customer.customer_id,
      dispute_id: dispute.id,
      evidence_due_by_iso: createdToIso(dispute.evidence_details.due_by),
      reason: dispute.reason,
      status: dispute.status
    };
  });

  const openDisputesWithDeadlines = disputes.items
    .filter((d) => OPEN_DISPUTE_STATUSES.has(d.status) && d.evidence_details?.due_by)
    .sort((a, b) => a.evidence_details!.due_by! - b.evidence_details!.due_by!);
  const nearestDeadline = openDisputesWithDeadlines[0];

  return {
    context: {
      period_label: period.label,
      status_filter: statusFilter,
      stripe_mode: stripeClient.mode,
      truncated: disputes.truncated
    },
    items,
    summary: {
      total_disputed_amount_cents: filtered.reduce((total, dispute) => total + dispute.amount, 0),
      open_count: disputes.items.filter((dispute) => OPEN_DISPUTE_STATUSES.has(dispute.status)).length,
      won_count_in_period: disputes.items.filter((dispute) => dispute.status === "won").length,
      lost_count_in_period: disputes.items.filter((dispute) => dispute.status === "lost").length,
      nearest_evidence_due_by_iso: nearestDeadline ? createdToIso(nearestDeadline.evidence_details.due_by) : null,
      nearest_evidence_due_dispute_id: nearestDeadline ? nearestDeadline.id : null
    }
  };
}

export const listDisputesTool: Tool<FastMCPSessionAuth, typeof listDisputesInputSchema> = {
  description: "List open or closed disputes for the requested period, including customer context and evidence deadlines.",
  name: "list_disputes",
  parameters: listDisputesInputSchema,
  async execute(args) {
    return executeCachedTool("list_disputes", args, async () => loadDisputes(args));
  }
};
