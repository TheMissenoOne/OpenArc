// Prints compare.ts JSON lines (stdin) as one line per region, then each disagreement class with one example.
const full = process.argv[2] === "--full";
for await (const l of (await import("node:readline")).createInterface({ input: process.stdin })) {
  const r = JSON.parse(l);
  if (r.crashed !== undefined || r.noBody || r.sameAsA) { console.log(r.region, r.noBody ? "no body" : r.sameAsA ? "same text as A" : `CRASH ${r.crashed} ${r.stderr}`); continue; }
  console.log(r.region, `inputs ${r.inputs} hangs ${JSON.stringify(r.hangs)} aWrong ${r.aWrong} disagree ${r.disagree} real ${r.real} falseAlarm ${r.falseAlarm} classes ${r.classes}`, JSON.stringify(Object.fromEntries(Object.entries(r.gaps).map(([g, v]) => [g, `${v.caught}/${v.inputs}`]))));
  if (full) for (const [c, v] of Object.entries(r.classList)) console.log("   ", c.slice(0, 60), v.n, JSON.stringify(v.example).slice(0, 300));
}
