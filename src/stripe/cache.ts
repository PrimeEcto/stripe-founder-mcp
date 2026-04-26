type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]);

    return Object.fromEntries(entries);
  }

  return value;
}

export function buildCacheKey(toolName: string, args: unknown): string {
  return `${toolName}:${JSON.stringify(sortJsonValue(args))}`;
}

export class TinyLruCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();

  public constructor(private readonly maxEntries = 256) {}

  public clear(): void {
    this.#entries.clear();
  }

  public get(key: string, now = Date.now()): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }

    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: T, ttlSeconds: number, now = Date.now()): void {
    if (this.#entries.has(key)) {
      this.#entries.delete(key);
    }

    this.#entries.set(key, {
      expiresAt: now + ttlSeconds * 1000,
      value
    });

    while (this.#entries.size > this.maxEntries) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }
      this.#entries.delete(oldestKey);
    }
  }
}
