import type { DateRangeInput, NormalizedDateRange } from "./types.js";

const MONTH_NAMES = new Map<string, number>([
  ["april", 3],
  ["august", 7],
  ["december", 11],
  ["february", 1],
  ["january", 0],
  ["july", 6],
  ["june", 5],
  ["march", 2],
  ["may", 4],
  ["november", 10],
  ["october", 9],
  ["september", 8]
]);

export interface NormalizedDatePoint {
  iso: string;
  label: string;
  value: Date;
}

function assertValidDate(value: Date, input: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid date input: ${input}`);
  }
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function endOfDayUtc(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + 1, 0, 0, 0, 0));
}

function endOfMonthUtc(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
}

function isIsoDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function parseMonthNameRange(input: string): NormalizedDateRange | undefined {
  const match = input.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!match) {
    return undefined;
  }

  const monthName = match[1];
  const yearText = match[2];
  if (!monthName || !yearText) {
    return undefined;
  }

  const monthIndex = MONTH_NAMES.get(monthName.toLowerCase());
  if (monthIndex === undefined) {
    return undefined;
  }

  const year = Number.parseInt(yearText, 10);
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = endOfMonthUtc(year, monthIndex);

  return {
    end,
    end_iso: end.toISOString(),
    label: `${monthName} ${year}`,
    start,
    start_iso: start.toISOString()
  };
}

function parseQuarterRange(input: string): NormalizedDateRange | undefined {
  const match = input.trim().match(/^(\d{4})-q([1-4])$/i);
  if (!match) {
    return undefined;
  }

  const yearText = match[1];
  const quarterText = match[2];
  if (!yearText || !quarterText) {
    return undefined;
  }

  const year = Number.parseInt(yearText, 10);
  const quarter = Number.parseInt(quarterText, 10);
  const monthIndex = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 3, 1, 0, 0, 0, 0));

  return {
    end,
    end_iso: end.toISOString(),
    label: `${year}-Q${quarter}`,
    start,
    start_iso: start.toISOString()
  };
}

function parseExplicitIsoDateRange(input: DateRangeInput): NormalizedDateRange | undefined {
  if (typeof input === "string") {
    if (isIsoDateOnly(input)) {
      const start = new Date(`${input}T00:00:00.000Z`);
      const end = endOfDayUtc(start);
      return {
        end,
        end_iso: end.toISOString(),
        label: input,
        start,
        start_iso: start.toISOString()
      };
    }

    if (/^\d{4}-\d{2}-\d{2}T/.test(input)) {
      const value = new Date(input);
      assertValidDate(value, input);
      return {
        end: value,
        end_iso: value.toISOString(),
        label: input,
        start: value,
        start_iso: value.toISOString()
      };
    }

    return undefined;
  }

  const start = isIsoDateOnly(input.start)
    ? new Date(`${input.start}T00:00:00.000Z`)
    : new Date(input.start);
  const end = isIsoDateOnly(input.end)
    ? new Date(`${input.end}T00:00:00.000Z`)
    : new Date(input.end);
  assertValidDate(start, input.start);
  assertValidDate(end, input.end);

  if (end <= start) {
    throw new Error("Date range end must be after start.");
  }

  return {
    end,
    end_iso: end.toISOString(),
    label: `${start.toISOString()}..${end.toISOString()}`,
    start,
    start_iso: start.toISOString()
  };
}

function buildRange(start: Date, end: Date, label: string): NormalizedDateRange {
  return {
    end,
    end_iso: end.toISOString(),
    label,
    start,
    start_iso: start.toISOString()
  };
}

function startOfMonthUtc(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfYearUtc(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
}

function subtractUtcDays(value: Date, days: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() - days, value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()));
}

function subtractUtcMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() - months, value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()));
}

function parseRelativeRange(input: string, now: Date): NormalizedDateRange | undefined {
  const token = normalizeToken(input);
  const nowUtc = cloneDate(now);

  if (token === "this_month") {
    return buildRange(startOfMonthUtc(nowUtc), nowUtc, "This month");
  }

  if (token === "last_month") {
    const start = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), 1, 0, 0, 0, 0));
    return buildRange(start, end, "Last month");
  }

  if (token === "ytd") {
    return buildRange(startOfYearUtc(nowUtc), nowUtc, "Year to date");
  }

  const lastDaysMatch = token.match(/^last_(\d+)_days$/);
  if (lastDaysMatch) {
    const daysText = lastDaysMatch[1];
    if (!daysText) {
      return undefined;
    }

    const days = Number.parseInt(daysText, 10);
    const end = nowUtc;
    const start = subtractUtcDays(end, days);
    return buildRange(start, end, `Last ${days} days`);
  }

  const daysAgoMatch = token.match(/^(\d+)_days_ago$/);
  if (daysAgoMatch) {
    const daysText = daysAgoMatch[1];
    if (!daysText) {
      return undefined;
    }

    const days = Number.parseInt(daysText, 10);
    const target = subtractUtcDays(nowUtc, days);
    const start = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 0, 0, 0, 0));
    const end = endOfDayUtc(target);
    return buildRange(start, end, `${days} days ago`);
  }

  const monthsAgoMatch = token.match(/^(\d+)_months_ago$/);
  if (monthsAgoMatch) {
    const monthsText = monthsAgoMatch[1];
    if (!monthsText) {
      return undefined;
    }

    const months = Number.parseInt(monthsText, 10);
    const target = subtractUtcMonths(nowUtc, months);
    const start = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 1, 0, 0, 0, 0));
    const end = endOfMonthUtc(target.getUTCFullYear(), target.getUTCMonth());
    return buildRange(start, end, `${months} months ago`);
  }

  return undefined;
}

export function normalizeDateRange(
  input: DateRangeInput | undefined,
  now = new Date(),
  fallback: DateRangeInput = "last_30_days"
): NormalizedDateRange {
  const candidate = input ?? fallback;
  const explicit = parseExplicitIsoDateRange(candidate);
  if (explicit) {
    return explicit;
  }

  if (typeof candidate === "string") {
    const quarter = parseQuarterRange(candidate);
    if (quarter) {
      return quarter;
    }

    const monthName = parseMonthNameRange(candidate);
    if (monthName) {
      return monthName;
    }

    const relative = parseRelativeRange(candidate, now);
    if (relative) {
      return relative;
    }
  }

  throw new Error(`Unsupported date range input: ${typeof candidate === "string" ? candidate : JSON.stringify(candidate)}`);
}

export function normalizeDatePoint(
  input: string | undefined,
  now = new Date(),
  fallback: string = new Date().toISOString()
): NormalizedDatePoint {
  const candidate = input ?? fallback;
  const explicit = parseExplicitIsoDateRange(candidate);
  if (explicit) {
    if (typeof candidate === "string" && /^\d{4}-\d{2}-\d{2}T/.test(candidate)) {
      return {
        iso: explicit.start.toISOString(),
        label: candidate,
        value: explicit.start
      };
    }

    return {
      iso: new Date(explicit.end.getTime() - 1).toISOString(),
      label: explicit.label,
      value: new Date(explicit.end.getTime() - 1)
    };
  }

  const range = normalizeDateRange(candidate, now, candidate);
  const point = new Date(range.end.getTime() - 1);
  return {
    iso: point.toISOString(),
    label: range.label,
    value: point
  };
}
