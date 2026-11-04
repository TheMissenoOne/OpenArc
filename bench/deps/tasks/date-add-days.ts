import * as arc from "open-arc";

type AddDays = (instant: string, days: number, timeZone: string) => string;

export const addDaysSpec = arc.defineRegion<AddDays>({
  id: "date.addDays",
  intent: [
    "instant is an ISO-8601 UTC timestamp. Add `days` calendar days (may be negative) in the IANA time zone `timeZone`,",
    "keeping the local wall-clock time even across daylight-saving changes, and return the resulting instant in",
    "Date#toISOString format (UTC, milliseconds, Z).",
  ],
  examples: [
    { args: ["2026-01-10T12:00:00.000Z", 3, "UTC"], expected: "2026-01-13T12:00:00.000Z" },
    { args: ["2026-03-07T17:00:00.000Z", 1, "America/New_York"], expected: "2026-03-08T16:00:00.000Z" },
    { args: ["2026-11-02T17:00:00.000Z", -2, "America/New_York"], expected: "2026-10-31T16:00:00.000Z" },
  ],
});
