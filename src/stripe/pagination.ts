import type { PaginationResult } from "../lib/types.js";

export interface AutoPaginatedCollection<T> {
  autoPagingEach(handler: (item: T) => boolean | void | Promise<boolean | void>): Promise<void>;
}

export async function collectAutoPaged<T>(
  collection: AutoPaginatedCollection<T>,
  maxResults: number
): Promise<PaginationResult<T>> {
  if (maxResults <= 0) {
    return {
      items: [],
      truncated: true
    };
  }

  const items: T[] = [];
  let truncated = false;

  await collection.autoPagingEach(async (item) => {
    if (items.length >= maxResults) {
      truncated = true;
      return false;
    }

    items.push(item);
    return true;
  });

  return {
    items,
    truncated
  };
}
