import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { logServerError } from "./lib/logger.js";
import { configureStripeClientContext } from "./stripe/client.js";
import { createServer } from "./server.js";

function readNumberEnv(name: string, fallbackValue: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallbackValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return parsed;
}

export async function main(): Promise<void> {
  const apiKey = process.env.STRIPE_API_KEY;
  if (apiKey) {
    configureStripeClientContext({
      apiKey,
      cacheTtlSeconds: readNumberEnv("CACHE_TTL_SECONDS", 60),
      maxListResults: readNumberEnv("MAX_LIST_RESULTS", 1000)
    });
  }

  const server = createServer();
  const transportType = process.env.MCP_TRANSPORT === "httpStream" ? "httpStream" : "stdio";

  if (transportType === "httpStream") {
    await server.start({
      httpStream: {
        port: readNumberEnv("PORT", 8080)
      },
      transportType
    });
    return;
  }

  await server.start({
    transportType
  });
}

const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : null;

if (entrypointPath && fileURLToPath(import.meta.url) === entrypointPath) {
  main().catch((error: unknown) => {
    logServerError(error);
    process.exitCode = 1;
  });
}
