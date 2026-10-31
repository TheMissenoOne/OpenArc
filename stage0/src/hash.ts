import * as arc from "open-arc";
import type { Json } from "open-arc";
import type { ChildSpan } from "./types.ts";
import ts from "typescript";
import { createHash } from "node:crypto";

// ── hash.canonicalJson ────────────────────────────────────────── spec §4.2
type CanonicalJson = (value: Json) => string;

export const canonicalJsonSpec = arc.defineRegion<CanonicalJson>({
  id: "hash.canonicalJson",
  intent: "JSON.stringify semantics for scalars, no whitespace, object keys sorted by UTF-16 code unit order at every depth, array order preserved.",
  examples: [
    { args: [{ b: 1, a: [true, null, "x"] }], expected: "{\"a\":[true,null,\"x\"],\"b\":1}" },
    { args: [{ z: { y: 2, x: 1 } }], expected: "{\"z\":{\"x\":1,\"y\":2}}" },
    { args: [[{ b: 2, a: 1 }]], expected: "[{\"a\":1,\"b\":2}]" },
    { args: ["é"], expected: "\"é\"" },
    { args: [1.5], expected: "1.5" },
  ],
});

// @openarc:begin hash.canonicalJson
export const canonicalJson: CanonicalJson = (value) => {
  const c = (v: Json): string =>
    Array.isArray(v)
      ? `[${v.map(c).join(",")}]`
      : v !== null && typeof v === "object"
        ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${c(v[k]!)}`).join(",")}}`
        : JSON.stringify(v);
  return c(value);
};
// @openarc:end hash.canonicalJson

// ── hash.normalizeOwnedText ───────────────────────────────────── spec §4.1
type NormalizeOwnedText = (lines: string[], children: ChildSpan[]) => string;

export const normalizeOwnedTextSpec = arc.defineRegion<NormalizeOwnedText>({
  id: "hash.normalizeOwnedText",
  intent: [
    "1. Strip one trailing \\r from every line (CRLF files hash like LF files, on every OS). Replace each child span lines[from..to]",
    "with the single line /*«openarc-child:<id>»*/ and join lines with \\n.",
    "2. Parse with ts.createSourceFile(setParentNodes=true). Walk node.getChildren() depth-first, skipping JSDoc nodes;",
    "for every leaf, emit its leading comment ranges, then its getText() if non-empty, then its trailing comment ranges (every comment once, trimmed; same-line trailing comments count).",
    "3. Join with single spaces. Never use the raw scanner: it does not rescan templates or regexes, so whitespace inside them would be lost.",
  ],
  deps: ["typescript"],
  examples: [
    { name: "whitespace-insensitive", args: [["const x=1;"], []], expected: "const x = 1 ;" },
    {
      name: "comments count",
      args: [["const  x = 1;", "// note", "return x;"], []],
      expected: "const x = 1 ; // note return x ;",
    },
    {
      name: "child replaced by slot",
      args: [["a();", "// @openarc:begin p.c", "b();", "// @openarc:end p.c", "c();"], [{ id: "p.c", from: 1, to: 3 }]],
      expected: "a ( ) ; /*«openarc-child:p.c»*/ c ( ) ;",
    },
    {
      name: "template whitespace is semantic",
      args: [["const t = `a ${b}   c`;"], []],
      expected: "const t = `a ${ b }   c` ;",
    },
    { name: "regex whitespace is semantic", args: [["x = /a  b/g;"], []], expected: "x = /a  b/g ;" },
    { name: "trailing comment counts", args: [["x = 1; // why"], []], expected: "x = 1 ; // why" },
    { name: "CRLF hashes like LF", args: [["const t = `a\r", "b`; // c\r"], []], expected: "const t = `a\nb` ; // c" },
  ],
});

// @openarc:begin hash.normalizeOwnedText
export const normalizeOwnedText: NormalizeOwnedText = (lines, children) => {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const c = children.find((x) => x.from === i);
    if (c) {
      out.push(`/*«openarc-child:${c.id}»*/`);
      i = c.to + 1;
    } else out.push(lines[i++]!.replace(/\r$/, ""));
  }
  const text = out.join("\n");
  const sf = ts.createSourceFile("r.ts", text, ts.ScriptTarget.Latest, true);
  const toks: string[] = [];
  const seen = new Set<number>();
  const visit = (n: ts.Node): void => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length) return kids.forEach(visit);
    const emit = (rs: readonly ts.CommentRange[] | undefined) => {
      for (const r of rs ?? [])
        if (!seen.has(r.pos)) {
          seen.add(r.pos);
          toks.push(text.slice(r.pos, r.end).trim());
        }
    };
    emit(ts.getLeadingCommentRanges(text, n.pos));
    const t = n.getText(sf);
    if (t !== "") toks.push(t);
    emit(ts.getTrailingCommentRanges(text, n.end));
  };
  visit(sf);
  return toks.join(" ");
};
// @openarc:end hash.normalizeOwnedText

// ── hash.sha256Tagged ─────────────────────────────────────────── spec §4.1
type Sha256Tagged = (text: string) => string;

export const sha256TaggedSpec = arc.defineRegion<Sha256Tagged>({
  id: "hash.sha256Tagged",
  intent: "'sha256:' + lowercase hex SHA-256 of the UTF-8 bytes of text.",
  deps: ["node:crypto"],
  examples: [
    { args: [""], expected: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    { args: ["abc"], expected: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    { args: ["const x = 1 ;"], expected: "sha256:60fe306eed8812b12eab2ef34e74175e14345f3d1ee945e3a9a19e463b249340" },
  ],
});

// @openarc:begin hash.sha256Tagged
export const sha256Tagged: Sha256Tagged = (text) => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
// @openarc:end hash.sha256Tagged
