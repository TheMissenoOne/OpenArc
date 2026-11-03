import * as arc from "open-arc";

type IsV4 = (s: string) => boolean;

export const isV4Spec = arc.defineRegion<IsV4>({
  id: "uuid.isV4",
  intent: "true iff s is a version-4 UUID (RFC 9562) in canonical form: 8-4-4-4-12 hexadecimal digits with hyphens, either case, version digit 4, variant digit 8, 9, a or b. Nothing else is accepted (no braces, no surrounding spaces).",
  examples: [
    { args: ["9b2c6f4e-3a1d-4e8b-9c7a-1f2e3d4c5b6a"], expected: true },
    { args: ["9b2c6f4e-3a1d-1e8b-9c7a-1f2e3d4c5b6a"], expected: false },
    { args: [""], expected: false },
  ],
});
