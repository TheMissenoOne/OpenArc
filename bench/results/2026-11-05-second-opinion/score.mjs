// Scores queue.sh's bodies against the decision rule in NOTES.md. Usage: node score.mjs <runs dir>
import { readFileSync, readdirSync, existsSync } from "node:fs";
const R = process.argv[2];
const SEVEN = ["parseOutput no body", "parseOutput bad import items", "parseOutput check order", "broadcast unknown peer", "broadcast __proto__ peer", "onGossip unsorted", "onGossip negative fanout"];
const CONTROLS = ["p2p.peerTable", "p2p.handshake", "p2p.encodeVarint"];
const bodies = readdirSync(R).filter((d) => existsSync(`${R}/${d}/compare.jsonl`)).sort();
const rows = {};
for (const b of bodies) rows[b] = readFileSync(`${R}/${b}/compare.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const caughtBy = (b) => new Set(rows[b].flatMap((r) => Object.entries(r.gaps ?? {}).filter(([, v]) => v.caught > 0).map(([g]) => g)));
console.log("body        built  gaps(of 7)  decoder-hang  control classes (real/falseAlarm inputs)");
for (const b of bodies) {
  const built = rows[b].filter((r) => r.inputs !== undefined);
  const c = caughtBy(b);
  const ctl = built.filter((r) => CONTROLS.includes(r.region)).map((r) => `${r.region.slice(4)}:${r.classes}(${r.real}/${r.falseAlarm})`);
  const bad = rows[b].filter((r) => r.crashed !== undefined || r.sameAsA).map((r) => r.region + (r.sameAsA ? " same" : " crash"));
  console.log(b.padEnd(11), `${built.length}/7`.padEnd(6), String(SEVEN.filter((g) => c.has(g)).length).padEnd(11), (c.has("decoder hang (found here, not one of the 7)") ? "yes" : "no").padEnd(13), ctl.join(" ") || "-", bad.join(","));
}
const union = (bs) => new Set(bs.flatMap((b) => [...caughtBy(b)]));
const s1 = bodies.filter((b) => b.endsWith("-s1"));
const uS1 = union(s1), uAll = union(bodies);
console.log(`\nRULE union seed 1 (${s1.join(", ")}): ${SEVEN.filter((g) => uS1.has(g)).length} of 7: ${SEVEN.filter((g) => uS1.has(g)).join("; ")}`);
console.log(`union all 9: ${SEVEN.filter((g) => uAll.has(g)).length} of 7: ${SEVEN.filter((g) => uAll.has(g)).join("; ")}`);
console.log(`missed by all 9: ${SEVEN.filter((g) => !uAll.has(g)).join("; ") || "none"}`);
const cls = bodies.flatMap((b) => rows[b].filter((r) => CONTROLS.includes(r.region) && r.inputs !== undefined).map((r) => r.classes)).sort((a, b) => a - b);
console.log(`control classes: n=${cls.length} median ${cls[Math.floor(cls.length / 2)] ?? "-"} max ${cls.at(-1) ?? "-"} values ${cls.join(",")}`);
const built = {}; for (const b of bodies) for (const r of rows[b]) { built[r.region] ??= [0, 0]; built[r.region][1]++; if (r.inputs !== undefined) built[r.region][0]++; }
console.log("built per region:", Object.entries(built).map(([k, v]) => `${k} ${v[0]}/${v[1]}`).join(" · "));
for (const g of SEVEN) console.log(`  ${g}: ${bodies.filter((b) => caughtBy(b).has(g)).join(", ") || "none"}`);
// load on target regions, and how often the disagreeing side A was the wrong one
for (const reg of ["model.parseOutput", "p2p.onGossip", "p2p.broadcast", "p2p.decodeLengthPrefixed"]) {
  const xs = bodies.flatMap((b) => rows[b].filter((r) => r.region === reg && r.inputs !== undefined));
  console.log(`  ${reg}: ${xs.length} bodies, classes ${xs.map((x) => x.classes).join(",")}; real ${xs.reduce((a, x) => a + x.real, 0)} falseAlarm ${xs.reduce((a, x) => a + x.falseAlarm, 0)}`);
}
