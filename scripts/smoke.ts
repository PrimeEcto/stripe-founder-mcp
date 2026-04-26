import "dotenv/config";

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  hasStripeTestKey,
  seedSharedFixtureSnapshot,
  type IntegrationFixtureSnapshot
} from "../tests/integration/fixtures.js";

interface SmokeCall {
  args: Record<string, unknown>;
  name: string;
}

interface TextContent {
  text?: string;
  type: string;
}

interface ToolCallResult {
  content?: TextContent[];
  isError?: boolean;
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function toSerializableEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function parseToolResponse(result: ToolCallResult): unknown {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) {
    return result;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function buildSmokeCalls(fixture: IntegrationFixtureSnapshot): SmokeCall[] {
  const primaryCustomer = fixture.customers.activeBasic.email ?? fixture.customers.activeBasic.id;
  const fullHistoryPeriod = {
    end: "2100-01-01T00:00:00.000Z",
    start: "2020-01-01T00:00:00.000Z"
  };

  return [
    { args: {}, name: "get_mrr" },
    { args: { period: "last_30_days" }, name: "get_growth_metrics" },
    { args: { customer: primaryCustomer }, name: "get_customer_profile" },
    { args: {}, name: "list_at_risk_customers" },
    { args: { limit: 10, period: fullHistoryPeriod }, name: "list_recent_signups" },
    { args: { period: "last_30_days" }, name: "get_failed_payment_recovery_rate" },
    { args: { period: fullHistoryPeriod, status: "actionable" }, name: "list_disputes" },
    { args: { period: fullHistoryPeriod }, name: "get_churn_summary" },
    {
      args: {
        context_hint: "refund request",
        customer: primaryCustomer
      },
      name: "get_support_context"
    }
  ];
}

async function main(): Promise<void> {
  if (!hasStripeTestKey()) {
    throw new Error("Smoke testing requires STRIPE_API_KEY=sk_test_...");
  }

  const serverEntrypoint = resolve(process.cwd(), "dist", "index.js");
  if (!existsSync(serverEntrypoint)) {
    throw new Error("Build output not found. Run `npx tsc -p tsconfig.build.json` before the smoke script.");
  }

  const fixture = await seedSharedFixtureSnapshot();
  const transport = new StdioClientTransport({
    args: [serverEntrypoint],
    command: process.execPath,
    cwd: process.cwd(),
    env: toSerializableEnvironment(),
    stderr: "pipe"
  });
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
  }

  const client = new Client(
    {
      name: "stripe-founder-mcp-smoke",
      version: "0.1.0"
    },
    {
      capabilities: {}
    }
  );

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    writeLine(JSON.stringify({ available_tools: tools.tools.map((tool) => tool.name) }, null, 2));

    for (const call of buildSmokeCalls(fixture)) {
      const response = (await client.callTool({
        arguments: call.args,
        name: call.name
      })) as ToolCallResult;
      const parsedResponse = parseToolResponse(response);

      writeLine(
        JSON.stringify(
          {
            arguments: call.args,
            response: parsedResponse,
            tool: call.name
          },
          null,
          2
        )
      );

      if (response.isError) {
        throw new Error(`Smoke tool call failed for ${call.name}.`);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
