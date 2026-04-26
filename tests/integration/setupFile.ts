import "dotenv/config";

import { configureStripeClientContext } from "../../src/stripe/client.js";
import { hasStripeTestKey } from "./fixtures.js";

if (hasStripeTestKey()) {
  configureStripeClientContext({
    apiKey: process.env.STRIPE_API_KEY as string,
    cacheTtlSeconds: 0,
    maxListResults: 1000
  });
}
