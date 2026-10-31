# OpenArc

**Compile typed specs into verified TypeScript with small local models.**

OpenArc treats an LLM as a *constrained compiler backend*, not as a chat partner:
- **You write the program:** interfaces, classes and the members you know, with `return arc.todo();` where the compiler should write a body, and tests as TypeScript (`arc.test`).
- **OpenArc builds a context package for that one function.** It's the code-generation equivalent of a unit test: only what the function needs, never the whole repository.
- **A local model returns a function body.**
- **The compiler verifies it:** type-check, static rules, then your examples in a sandbox.
- **Only then is the body spliced in.** Your hand edits are never overwritten.

The hypothesis behind it:

> A small model working on a well-defined, isolated problem can be more reliable than a large model working on a poorly constrained, repository-wide one.

## Start here

- [[Getting Started]]: install, init, compile your first region
- [[Code First]]: the main way since 0.9.0: pending bodies in functions and classes, JSDoc intent, `arc.test`, hidden tests, laws
- [[Writing Specs]]: code first in brief, then `defineRegion`, examples, blocks, sketches, concepts, TSX UI specs
- [[Your own palette|Palette]]: build your own reusable concepts: laws, variants, sketches, code-first classes and tests (the bundled palette is deprecated and frozen since 0.9.0)
- [[Configuration]]: `openarc.config.json`; local Ollama or APIs (OpenAI, OpenRouter, Anthropic…) per region
- [[Context Packages]]: how much the model sees, and when that grows
- [[Safety Model]]: what the model can and cannot touch, enforced in code
- [[Fakes]]: testing functions with effects
- [[Adopting Existing Code]]: `openarc extract` turns functions you already have into regions
- [[Watch Mode]]: `openarc watch` recompiles regions as you save, one at a time
- [[CLI Reference]]
- [[Bootstrap]]: OpenArc compiling OpenArc
- [[Design Log]]: every finding that changed the spec

The normative specification is [`SPEC-phase0.md`](https://github.com/TheMissenoOne/OpenArc/blob/main/SPEC-phase0.md).
