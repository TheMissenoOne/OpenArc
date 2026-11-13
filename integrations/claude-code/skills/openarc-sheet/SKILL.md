---
name: openarc-sheet
description: Use in a repo with openarc.spec.md or openarc.config.json, when asked to change specs, fix a failed region or review OpenArc suggestions.
---

# OpenArc

The person edits `openarc.spec.md`. `openarc sync --watch` carries edits between that file and the TypeScript, and compiles regions on local or configured backends. Saves cost no agent turn, so stay out of that loop.

Keep token use low:
- Run OpenArc as `$OPENARC_BIN` if set, else `node_modules/.bin/openarc` (from `npm i -D open-arc`), else `openarc` when installed globally. Never `npx openarc`: no npm package has that name, so npx would look it up and could install someone else's.
- Start from `node_modules/.bin/openarc sync --brief --no-model`, one line. Don't read `openarc.spec.md` whole.
- For one region, run `node_modules/.bin/openarc inspect <id>` and read only that region's part of the sheet (`grep -n -A25 "^## <id>" openarc.spec.md`).
- Don't generate bodies yourself while a backend can: edit the spec, then sync. Write a body only when asked, or after a region has failed on its backends, and then as the host agent (below).

## Compiling as the host agent

To implement a pending or stale region yourself, with no model backend: run `openarc prompt <id>`, write the body it asks for, and pipe it to `openarc accept <id>`. Accept runs the compiler's checks (static rules, type check, sandboxed examples and tests) and commits only if all pass. Otherwise it prints the problems: fix the body and accept again, at most twice, then report what still fails. Both take `--json`; `openarc` here is the binary named above.

Rules:
- TypeScript is the source of truth: JSDoc, `arc.configure`, `arc.test`. Never edit between `@openarc:begin` and `@openarc:end` unless the person wants that region to become developer-owned (`openarc freeze <id>`). A hook may refuse such an edit; `openarc guard` lists any that got through.
- A verified region means its examples pass, not that it meets its intent. To tighten a region, add an example that shows the case.
- Tick a suggestion only when the person agrees: it changes the spec to match the code.
- `src/*.arc.ts` holds generated `arc.configure` statements. Edit examples through the sheet.
