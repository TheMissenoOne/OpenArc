export const meta = { export: "isV4", expectLib: true, note: "e.g. uuid (validate + version)" };
export const cases = [
  { args: ["123E4567-E89B-42D3-A456-426614174000"], expected: true },
  { args: ["123e4567-e89b-42d3-c456-426614174000"], expected: false },
  { args: ["123e4567e89b42d3a456426614174000"], expected: false },
  { args: ["{123e4567-e89b-42d3-a456-426614174000}"], expected: false },
  { args: [" 123e4567-e89b-42d3-a456-426614174000"], expected: false },
  { args: ["00000000-0000-0000-0000-000000000000"], expected: false },
  { args: ["123e4567-e89b-42d3-b456-42661417400g"], expected: false },
  { args: ["f47ac10b-58cc-4372-a567-0e02b2c3d479"], expected: true },
];
