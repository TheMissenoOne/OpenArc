# OpenArc

**Compile typed specs into verified TypeScript with small local models.**

OpenArc treats an LLM as a *constrained compiler backend*, not as a chat partner:
- **You write the contract:** a function type, an intent and examples.
- **OpenArc builds a context package for that one function.** It's the code-generation equivalent of a unit test: only what the function needs, never the whole repository.
- **A local model returns a function body.**
- **The compiler verifies it:** type-check, static rules, then your examples in a sandbox.
- **Only then is the body spliced in.** Your hand edits are never overwritten.

The hypothesis behind it:

> A small model working on a well-defined, isolated problem can be more reliable than a large model working on a poorly constrained, repository-wide one.

## Start here

- [[Getting Started]]: install, init, compile your first region
- [[Writing Specs]]: `defineRegion`, examples, blocks, mixed resolution
- [[Configuration]]: `openarc.config.json`; local Ollama or APIs (OpenAI, OpenRouter, Anthropic…) per region
- [[Context Packages]]: how much the model sees, and when that grows
- [[Safety Model]]: what the model can and cannot touch, enforced in code
- [[Fakes]]: testing functions with effects
- [[Adopting Existing Code]]: `openarc extract` turns functions you already have into regions
- [[CLI Reference]]
- [[Bootstrap]]: OpenArc compiling OpenArc
- [[Design Log]]: every finding that changed the spec

The normative specification is [`SPEC-phase0.md`](https://github.com/TheMissenoOne/OpenArc/blob/main/SPEC-phase0.md).
