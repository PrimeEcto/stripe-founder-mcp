import { buildCacheKey, TinyLruCache } from "../../../src/stripe/cache.js";

describe("buildCacheKey", () => {
  it("sorts object keys for stable cache keys", () => {
    expect(buildCacheKey("tool", { b: 2, a: 1 })).toBe(buildCacheKey("tool", { a: 1, b: 2 }));
  });
});

describe("TinyLruCache", () => {
  it("returns cached values before expiry", () => {
    const cache = new TinyLruCache<string>(2);

    cache.set("alpha", "value", 10, 1_000);

    expect(cache.get("alpha", 1_500)).toBe("value");
  });

  it("expires values after ttl", () => {
    const cache = new TinyLruCache<string>(2);

    cache.set("alpha", "value", 1, 1_000);

    expect(cache.get("alpha", 2_001)).toBeUndefined();
  });

  it("evicts the least recently used value when capacity is exceeded", () => {
    const cache = new TinyLruCache<string>(2);

    cache.set("alpha", "a", 10, 1_000);
    cache.set("beta", "b", 10, 1_000);
    expect(cache.get("alpha", 1_100)).toBe("a");

    cache.set("gamma", "c", 10, 1_200);

    expect(cache.get("beta", 1_300)).toBeUndefined();
    expect(cache.get("alpha", 1_300)).toBe("a");
    expect(cache.get("gamma", 1_300)).toBe("c");
  });
});
