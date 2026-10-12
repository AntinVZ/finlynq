/**
 * Unit tests for getPresetRange — "last-12" complete-calendar-month fix (FINLYNQ-203).
 *
 * The function accepts an optional `now` parameter so we can pin the clock
 * to a known date and assert the exact output without timezone ambiguity.
 */
import { describe, it, expect } from "vitest";
import { getPresetRange } from "@/app/(app)/reports/page";

describe("getPresetRange — last-12 (FINLYNQ-203)", () => {
  it("tc-1: standard case (2026-06-18) → 2025-06-01 to 2026-05-31", () => {
    const result = getPresetRange("last-12", new Date(2026, 5, 18)); // month 5 = June
    expect(result).toEqual({ start: "2025-06-01", end: "2026-05-31" });
  });

  it("tc-2: year boundary (2026-01-05) → 2025-01-01 to 2025-12-31", () => {
    const result = getPresetRange("last-12", new Date(2026, 0, 5)); // month 0 = January
    expect(result).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });

  it("tc-3: prior month Feb non-leap (2026-03-31) → 2025-03-01 to 2026-02-28", () => {
    const result = getPresetRange("last-12", new Date(2026, 2, 31)); // month 2 = March
    expect(result).toEqual({ start: "2025-03-01", end: "2026-02-28" });
  });

  it("tc-4: prior month Feb leap (2024-03-10) → 2023-03-01 to 2024-02-29", () => {
    const result = getPresetRange("last-12", new Date(2024, 2, 10)); // month 2 = March; 2024 is a leap year
    expect(result).toEqual({ start: "2023-03-01", end: "2024-02-29" });
  });
});

describe("getPresetRange — multi-year presets (yearly Reports view)", () => {
  it("last-5-years starts on Jan 1 four years back, so it spans five calendar years", () => {
    const { start } = getPresetRange("last-5-years", new Date(2026, 9, 12));
    expect(start).toBe("2022-01-01");
  });

  it("all-time starts before any plausible transaction", () => {
    const { start } = getPresetRange("all-time", new Date(2026, 9, 12));
    expect(start).toBe("1970-01-01");
  });

  it("both multi-year presets end today, like the other to-date presets", () => {
    const ytd = getPresetRange("ytd", new Date(2026, 9, 12));
    expect(getPresetRange("last-5-years", new Date(2026, 9, 12)).end).toBe(ytd.end);
    expect(getPresetRange("all-time", new Date(2026, 9, 12)).end).toBe(ytd.end);
  });
});
