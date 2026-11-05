---
name: openarc-sheet
description: Use in a repo with openarc.spec.md or openarc.config.json, when asked to change specs, fix a failed region or review OpenArc suggestions.
---

# OpenArc

The person edits `openarc.spec.md`. `openarc sync --watch` carries edits between that file and the TypeScript, and compiles regions on local or configured backends. Saves cost no agent turn, so stay out of that loop.

Keep token use low:
- Start from `npx openarc sync --brief --no-model` (or `openarc` when installed globally), one line. Don't read `openarc.spec.md` whole.
- For one region, run `npx openarc inspect <id>` and read only that region's part of the sheet (`grep -n -A25 "^## <id>" openarc.spec.md`).
- Don't generate bodies yourself while a backend can: edit the spec, then sync. Write a body by hand only when asked, or after a region has failed on its backends.

Rules:
- TypeScript is the source of truth: JSDoc, `arc.configure`, `arc.test`. Never edit between `@openarc:begin` and `@openarc:end` unless the person wants that region to become developer-owned.
- A verified region means its examples pass, not that it meets its intent. To tighten a region, add an example that shows the case.
- Tick a suggestion only when the person agrees: it changes the spec to match the code.
- `src/*.arc.ts` holds generated `arc.configure` statements. Edit examples through the sheet.
