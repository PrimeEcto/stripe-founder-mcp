import type Stripe from "stripe";

export type StripeMode = "live" | "test";

export type DateRangeInput =
  | string
  | {
      end: string;
      start: string;
    };

export interface NormalizedDateRange {
  end: Date;
  end_iso: string;
  label: string;
  start: Date;
  start_iso: string;
}

export interface MoneyValue {
  amount_cents: number;
  currency: string;
  formatted: string;
}

export interface PaginationResult<T> {
  items: T[];
  truncated: boolean;
}

export interface ToolResult<
  TSummary extends object,
  TContext extends object,
  TItem extends object
> {
  context: TContext;
  items: TItem[];
  summary: TSummary;
}

export interface StripeRuntimeOptions {
  apiKey: string;
  cacheTtlSeconds: number;
  maxListResults: number;
}

export interface StripeClientContext {
  cacheTtlSeconds: number;
  getCachedToolResult<T>(toolName: string, args: unknown, loader: () => Promise<T>): Promise<T>;
  maxListResults: number;
  mode: StripeMode;
  stripe: Stripe;
}

export interface ToolLogPayload {
  args: unknown;
  duration_ms?: number;
  item_count?: number;
  tool_name: string;
}

export interface TextToolResponse {
  content: Array<{
    text: string;
    type: "text";
  }>;
}

export function toToolTextResult<
  TSummary extends object,
  TContext extends object,
  TItem extends object
>(result: ToolResult<TSummary, TContext, TItem>): TextToolResponse {
  return {
    content: [
      {
        text: JSON.stringify(result, null, 2),
        type: "text"
      }
    ]
  };
}
