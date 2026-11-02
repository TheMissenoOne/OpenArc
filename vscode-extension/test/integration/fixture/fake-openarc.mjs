// Stands in for the openarc CLI (openarc.cliPath in .vscode/settings.json): canned `graph` and `lint` output, every call logged.
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.OPENARC_FAKE_LOG) appendFileSync(process.env.OPENARC_FAKE_LOG, args.join(" ") + "\n");
if (args[0] === "graph") {
  console.log("math.add                           F pending    1 ex  src/math.ts");
  console.log("math.sub                           F stale      1 ex  src/math.ts");
  console.log("math.mul                           F pending    1 ex  src/math.ts");
  console.log("math.div                           F pending    1 ex  src/math.ts");
} else if (args[0] === "lint") {
  console.log(JSON.stringify([{ rule: "spec/thin-examples", severity: "warn", id: "math.div", file: "src/math.ts", line: 7, message: "thin examples (examples:1): fewer than 3, or none with an edge case (empty, zero, negative, null)" }]));
} else console.log(`fake openarc ${args.join(" ")}`);
