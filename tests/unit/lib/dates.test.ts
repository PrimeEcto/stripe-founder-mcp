import { normalizeDatePoint, normalizeDateRange } from "../../../src/lib/dates.js";

const NOW = new Date("2026-04-26T12:00:00.000Z");

describe("normalizeDateRange", () => {
  it("parses relative day windows", () => {
    const range = normalizeDateRange("last_30_days", NOW);

    expect(range.start_iso).toBe("2026-03-27T12:00:00.000Z");
    expect(range.end_iso).toBe("2026-04-26T12:00:00.000Z");
    expect(range.label).toBe("Last 30 days");
  });

  it("parses this month", () => {
    const range = normalizeDateRange("this_month", NOW);

    expect(range.start_iso).toBe("2026-04-01T00:00:00.000Z");
    expect(range.end_iso).toBe("2026-04-26T12:00:00.000Z");
  });

  it("parses last month", () => {
    const range = normalizeDateRange("last month", NOW);

    expect(range.start_iso).toBe("2026-03-01T00:00:00.000Z");
    expect(range.end_iso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("parses year to date", () => {
    const range = normalizeDateRange("ytd", NOW);

    expect(range.start_iso).toBe("2026-01-01T00:00:00.000Z");
    expect(range.end_iso).toBe("2026-04-26T12:00:00.000Z");
  });

  it("parses days ago as a full UTC day", () => {
    const range = normalizeDateRange("7_days_ago", NOW);

    expect(range.start_iso).toBe("2026-04-19T00:00:00.000Z");
    expect(range.end_iso).toBe("2026-04-20T00:00:00.000Z");
  });

  it("parses months ago as a full calendar month", () => {
    const range = normalizeDateRange("2_months_ago", NOW);

    expect(range.start_iso).toBe("2026-02-01T00:00:00.000Z");
    expect(range.end_iso).toBe("2026-03-01T00:00:00.000Z");
  });

  it("parses quarter ranges", () => {
    const range = normalizeDateRange("2026-Q1", NOW);

    expect(range.start_iso).toBe("2026-01-01T00:00:00.000Z");
    expect(range.end_iso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("parses month name ranges", () => {
    const range = normalizeDateRange("March 2026", NOW);

    expect(range.start_iso).toBe("2026-03-01T00:00:00.000Z");
    expect(range.end_iso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("parses explicit ISO ranges", () => {
    const range = normalizeDateRange(
      {
        end: "2026-04-10T00:00:00.000Z",
        start: "2026-04-01T00:00:00.000Z"
      },
      NOW
    );

    expect(range.start_iso).toBe("2026-04-01T00:00:00.000Z");
    expect(range.end_iso).toBe("2026-04-10T00:00:00.000Z");
  });

  it("uses the fallback when input is undefined", () => {
    const range = normalizeDateRange(undefined, NOW, "last_7_days");

    expect(range.label).toBe("Last 7 days");
  });

  it("rejects invalid or inverted ranges", () => {
    expect(() =>
      normalizeDateRange(
        {
          end: "2026-04-01T00:00:00.000Z",
          start: "2026-04-10T00:00:00.000Z"
        },
        NOW
      )
    ).toThrow(/end must be after start/i);

    expect(() => normalizeDateRange("not-a-range", NOW)).toThrow(/Unsupported date range input/);
  });
});

describe("normalizeDatePoint", () => {
  it("parses ISO datetimes directly", () => {
    const point = normalizeDatePoint("2026-04-10T12:30:00.000Z", NOW);

    expect(point.iso).toBe("2026-04-10T12:30:00.000Z");
  });

  it("converts a relative range token into its terminal instant", () => {
    const point = normalizeDatePoint("last_month", NOW);

    expect(point.iso).toBe("2026-03-31T23:59:59.999Z");
    expect(point.label).toBe("Last month");
  });

  it("treats date-only input as the end of that day", () => {
    const point = normalizeDatePoint("2026-04-10", NOW);

    expect(point.iso).toBe("2026-04-10T23:59:59.999Z");
  });
});
