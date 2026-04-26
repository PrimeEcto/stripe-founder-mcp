import { logToolEnd, logToolStart } from "./logger.js";
import type { TextToolResponse, ToolResult } from "./types.js";
import { toToolTextResult } from "./types.js";
import { getStripeClientContext } from "../stripe/client.js";

export async function executeCachedTool<
  TSummary extends object,
  TContext extends object,
  TItem extends object
>(
  toolName: string,
  args: unknown,
  loader: () => Promise<ToolResult<TSummary, TContext, TItem>>
): Promise<TextToolResponse> {
  const startedAt = Date.now();
  logToolStart({
    args,
    tool_name: toolName
  });

  const result = await getStripeClientContext().getCachedToolResult(toolName, args, loader);

  logToolEnd({
    args,
    duration_ms: Date.now() - startedAt,
    item_count: result.items.length,
    tool_name: toolName
  });

  return toToolTextResult(result);
}
