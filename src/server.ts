import { FastMCP } from "fastmcp";

import { tools } from "./tools/index.js";

export function createServer(): FastMCP {
  const server = new FastMCP({
    instructions:
      "Founder-shaped Stripe analytics tools. Every response returns JSON with summary, context, and items in that order.",
    name: "stripe-founder-mcp",
    version: "0.1.0"
  });

  server.addTools(tools);
  return server;
}
