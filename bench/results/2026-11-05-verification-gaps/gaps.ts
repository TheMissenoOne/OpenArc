// Classifies oracle disagreements between the generated selfhost bodies and stage0 against the known gaps. Needs #73's bodies. Run from stage0: node --no-warnings ../bench/results/2026-11-05-verification-gaps/gaps.ts
import * as MA from "../../../selfhost/src/model.ts";
import * as MB from "../../../stage0/src/model.ts";
import * as PA from "../../../selfhost/src/palette/p2p.ts";
import * as PB from "../../../stage0/src/palette/p2p.ts";
import * as engine from "../../../stage0/src/engine.ts";
const ex = (s: any) => s.examples ?? s.spec?.examples ?? s.__spec?.examples;
const J = JSON.stringify;
for (const n of [60, 1000, 5000]) {
  const c: Record<string, number> = { total: 0, disagree: 0, missingBody: 0, emptyObject: 0, badImportItem: 0, order: 0, other: 0 };
  for (const [raw] of engine.oracleInputs(ex(MB.parseOutputSpec), n, 1) as [string][]) {
    c.total++;
    const a = J(MA.parseOutput(raw)), b = J(MB.parseOutput(raw));
    let o: any; try { o = JSON.parse(raw); } catch {}
    if (o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === 0) c.emptyObject++;
    if (a === b) continue;
    c.disagree++;
    const isObj = o && typeof o === "object" && !Array.isArray(o);
    if (isObj && !("body" in o)) c.missingBody++;
    else if (a.includes('"ok":true') && b.includes("bad-imports")) c.badImportItem++;
    else if (a.includes("bad-imports") && b.includes("unexpected-property")) c.order++;
    else { c.other++; if (c.other < 3) console.log("  other", raw, a, b); }
  }
  console.log("parseOutput", n, J(c));
  const g: Record<string, number> = { total: 0, disagree: 0, negFanoutInputs: 0, negFanoutDisagree: 0, unsortedInputs: 0, unsortedDisagree: 0 };
  for (const args of engine.oracleInputs(ex(PB.onGossipSpec), n, 1) as any[]) {
    g.total++;
    const [st, from, msg, fan] = args; let a: string, b: string;
    try { a = J((PA as any).onGossip(st, from, msg, fan)); } catch (e) { a = "throw"; }
    try { b = J((PB as any).onGossip(st, from, msg, fan)); } catch (e) { b = "throw"; }
    const neg = typeof fan === "number" && fan < 0; const uns = Array.isArray(st?.peers) && J([...st.peers].sort()) !== J(st.peers);
    if (neg) g.negFanoutInputs++; if (uns) g.unsortedInputs++;
    if (a !== b) { g.disagree++; if (neg) g.negFanoutDisagree++; if (uns) g.unsortedDisagree++; }
  }
  console.log("onGossip", n, J(g));
}
