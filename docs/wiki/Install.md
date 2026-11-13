# Install

## npm (the main way)

The package is [`open-arc` on npm](https://www.npmjs.com/package/open-arc); the command it installs is `openarc`. It needs Node 23.6 or later (25+ recommended).

```bash
npm i -D open-arc      # in a project
npx openarc doctor     # which sandbox tier this machine uses
```

A project that writes code-first specs (`import * as arc from "open-arc"`, `arc.todo()`, `arc.test`) needs this: its own code imports the package. See [[Getting Started]].

## Standalone download (no Node or npm needed)

Each [GitHub Release](https://github.com/TheMissenoOne/OpenArc/releases) built by the release workflow (`.github/workflows/release.yml`) has a tarball per platform and a `SHA256SUMS` file:

| File | Platform |
|---|---|
| `openarc-<version>-linux-x64.tar.gz` | Linux x86-64, glibc 2.28 or later (not Alpine/musl) |
| `openarc-<version>-linux-arm64.tar.gz` | Linux ARM64, glibc 2.28 or later |
| `openarc-<version>-darwin-arm64.tar.gz` | macOS on Apple silicon |

There is no Windows or Intel-macOS download: use npm there.

The tarball is the same npm package plus the Node runtime it was built and tested with (about 46 MB packed, 150 MB unpacked) and a `bin/openarc` launcher. It is not a single-file executable: Node's single executable applications cannot load the package's files or act as the Node runtime the example sandbox starts, so the runtime ships as a plain `bin/node` next to the package.

```bash
v=0.11.0; f=openarc-$v-linux-x64.tar.gz
curl -LO https://github.com/TheMissenoOne/OpenArc/releases/download/v$v/$f
curl -LO https://github.com/TheMissenoOne/OpenArc/releases/download/v$v/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS     # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
tar -xzf $f -C ~/.local/opt                        # any folder; keep it in place
ln -s ~/.local/opt/openarc-$v-linux-x64/bin/openarc ~/.local/bin/openarc
openarc doctor
```

On macOS, a tarball downloaded with a browser is quarantined; `xattr -dr com.apple.quarantine <folder>` after unpacking, or download with `curl` as above.

What works, with the bundled Node and no other Node installed: `decompile` (JavaScript and TypeScript code runs in the sandbox with the bundled Node), `decompile --check`, `arc status`, `view`, `status`, `arch`, `concept`, `setup` and the wrapper it writes, the [[MCP]] server, and `doctor`. The release workflow runs the download with no `node` on the `PATH` before attaching it. The sandbox tiers are the same as for npm ([[Safety Model]]); on Linux, install bubblewrap for the strong tier.

Limits:
- A code-first project (one whose sources import `open-arc`) still needs `npm i -D open-arc` in that project; the standalone `openarc` does not provide the package to your code or to `tsc`.
- The bundled Node is the one in the tarball, not yours. `sandbox.nodeBin` in [[Configuration]] still picks another one for the sandbox.
- `openarc setup` writes `.openarc/bin/openarc` pointing at the unpacked folder, as with npm it points at the install: move or delete that folder and run `setup` again.
- No automatic updates: download a newer tarball.
