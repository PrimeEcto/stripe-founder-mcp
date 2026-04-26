import { collectAutoPaged } from "../../../src/stripe/pagination.js";

function createCollection(values: number[]) {
  return {
    async autoPagingEach(handler: (item: number) => boolean | void | Promise<boolean | void>): Promise<void> {
      for (const value of values) {
        const shouldContinue = await handler(value);
        if (shouldContinue === false) {
          return;
        }
      }
    }
  };
}

describe("collectAutoPaged", () => {
  it("collects results up to the requested cap", async () => {
    const result = await collectAutoPaged(createCollection([1, 2, 3]), 2);

    expect(result).toEqual({
      items: [1, 2],
      truncated: true
    });
  });

  it("marks zero-cap collections as truncated", async () => {
    const result = await collectAutoPaged(createCollection([1, 2, 3]), 0);

    expect(result).toEqual({
      items: [],
      truncated: true
    });
  });

  it("returns all items when below the cap", async () => {
    const result = await collectAutoPaged(createCollection([1, 2]), 5);

    expect(result).toEqual({
      items: [1, 2],
      truncated: false
    });
  });
});
