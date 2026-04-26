import type { IntegrationFixtureSnapshot } from "./fixtures.js";

import { readSharedFixtureSnapshot } from "./fixtures.js";

let cachedSnapshot: IntegrationFixtureSnapshot | undefined;

export async function getSharedFixtureSnapshot(): Promise<IntegrationFixtureSnapshot> {
  if (cachedSnapshot) {
    return cachedSnapshot;
  }

  cachedSnapshot = await readSharedFixtureSnapshot();
  return cachedSnapshot;
}

export function parseToolResponse<T>(response: unknown): T {
  const text = (response as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as T;
}
