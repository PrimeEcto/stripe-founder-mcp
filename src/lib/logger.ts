import type { ToolLogPayload } from "./types.js";

type LogLevel = "debug" | "error" | "info" | "warn";

function writeLog(level: LogLevel, payload: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ level, ...payload })}\n`);
}

export function logToolStart(payload: ToolLogPayload): void {
  writeLog("info", {
    args: payload.args,
    event: "tool_start",
    tool_name: payload.tool_name
  });
}

export function logToolEnd(payload: ToolLogPayload): void {
  writeLog("info", {
    duration_ms: payload.duration_ms,
    event: "tool_end",
    item_count: payload.item_count,
    tool_name: payload.tool_name
  });
}

export function logServerError(error: unknown): void {
  writeLog("error", {
    error: error instanceof Error ? error.message : String(error),
    event: "server_error"
  });
}
