import type Stripe from "stripe";

import { getStripeClientContext } from "../stripe/client.js";
import { collectAutoPaged } from "../stripe/pagination.js";

const PRODUCT_BATCH_SIZE = 100;

function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];

  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }

  return chunks;
}

async function loadProductsByIds(ids: string[], cacheNamespace: string): Promise<Map<string, Stripe.Product>> {
  const stripeClient = getStripeClientContext();
  const productMap = new Map<string, Stripe.Product>();

  for (const batch of chunkIds([...ids].sort(), PRODUCT_BATCH_SIZE)) {
    const products = await stripeClient.getCachedToolResult(
      "stripe_products:batch",
      {
        cache_namespace: cacheNamespace,
        ids: batch
      },
      async () =>
        collectAutoPaged(
          stripeClient.stripe.products.list({
            ids: batch,
            limit: batch.length
          }),
          batch.length
        )
    );

    for (const product of products.items) {
      productMap.set(product.id, product);
    }
  }

  return productMap;
}

export async function hydrateSubscriptionProducts(
  subscriptions: Stripe.Subscription[],
  cacheNamespace: string
): Promise<Stripe.Subscription[]> {
  const unresolvedProductIds = Array.from(
    new Set(
      subscriptions.flatMap((subscription) =>
        subscription.items.data
          .map((item) => item.price.product)
          .filter((product): product is string => typeof product === "string")
      )
    )
  );

  if (unresolvedProductIds.length === 0) {
    return subscriptions;
  }

  const productsById = await loadProductsByIds(unresolvedProductIds, cacheNamespace);

  return subscriptions.map((subscription) => ({
    ...subscription,
    items: {
      ...subscription.items,
      data: subscription.items.data.map((item) => {
        const productId = typeof item.price.product === "string" ? item.price.product : null;
        const hydratedProduct = productId ? productsById.get(productId) : undefined;

        if (!hydratedProduct) {
          return item;
        }

        return {
          ...item,
          price: {
            ...item.price,
            product: hydratedProduct
          }
        } as Stripe.SubscriptionItem;
      })
    }
  })) as Stripe.Subscription[];
}
