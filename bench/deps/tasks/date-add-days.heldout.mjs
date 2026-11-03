export const meta = { export: "addDays", expectLib: true, note: "e.g. luxon, date-fns-tz, @date-fns/tz" };
export const cases = [
  { args: ["2026-03-28T11:00:00.000Z", 1, "Europe/Berlin"], expected: "2026-03-29T10:00:00.000Z" },
  { args: ["2026-10-24T10:00:00.000Z", 1, "Europe/Berlin"], expected: "2026-10-25T11:00:00.000Z" },
  { args: ["2026-04-04T01:00:00.000Z", 1, "Australia/Sydney"], expected: "2026-04-05T02:00:00.000Z" },
  { args: ["2026-10-04T02:00:00.000Z", -1, "Australia/Sydney"], expected: "2026-10-03T03:00:00.000Z" },
  { args: ["2026-03-01T17:00:00.000Z", 14, "America/New_York"], expected: "2026-03-15T16:00:00.000Z" },
  { args: ["2026-01-31T23:30:00.000Z", 30, "UTC"], expected: "2026-03-02T23:30:00.000Z" },
  { args: ["2026-06-15T08:15:30.250Z", 0, "Asia/Kolkata"], expected: "2026-06-15T08:15:30.250Z" },
  { args: ["2026-12-31T22:00:00.000Z", 1, "Asia/Tokyo"], expected: "2027-01-01T22:00:00.000Z" },
];
