import type { GlobalSetupContext } from "vitest/node";

import {
  hasStripeTestKey,
  removeSharedFixtureSnapshot,
  seedSharedFixtureSnapshot
} from "./fixtures.js";

export default async function integrationGlobalSetup(_context: GlobalSetupContext): Promise<() => Promise<void>> {
  if (!hasStripeTestKey()) {
    await removeSharedFixtureSnapshot();
    return async () => {
      await removeSharedFixtureSnapshot();
    };
  }

  await seedSharedFixtureSnapshot();

  return async () => {
    await removeSharedFixtureSnapshot();
  };
}
