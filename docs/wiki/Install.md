# Install

## npm (the main way)

The package is [`open-arc` on npm](https://www.npmjs.com/package/open-arc); the command it installs is `openarc`. It needs Node 23.6 or later (25+ recommended).

```bash
npm i -D open-arc      # in a project
npx openarc doctor     # which sandbox tier this machine uses
```

A project that writes code-first specs (`import * as arc from "open-arc"`, `arc.todo()`, `arc.test`) needs this: its own code imports the package. See [[Getting Started]].

## Standalone download (no Node or npm needed)

Each [GitHub Release](https://github.com/TheMissenoOne/OpenArc/releases) built by the release workflow (`.github/workflows/release.yml`) has an archive per platform and a `SHA256SUMS` file (no release has been built by it yet). CI builds and checks the same archives on every push (`.github/workflows/binary.yml`), without publishing them:

| File | Platform | Launcher | Runner |
|---|---|---|---|
| `openarc-<version>-linux-x64.tar.gz` | Linux x86-64, glibc 2.28 or later (not Alpine/musl) | `bin/openarc` (sh) | `ubuntu-latest` |
| `openarc-<version>-linux-arm64.tar.gz` | Linux ARM64, glibc 2.28 or later | `bin/openarc` (sh) | `ubuntu-24.04-arm` |
| `openarc-<version>-darwin-arm64.tar.gz` | macOS on Apple silicon | `bin/openarc` (sh) | `macos-latest` |
| `openarc-<version>-darwin-x64.tar.gz` | macOS on Intel | `bin/openarc` (sh) | `macos-15-intel` |
| `openarc-<version>-win32-x64.zip` | Windows x86-64 | `bin\openarc.cmd` | `windows-latest` |

There is no Windows ARM64 or musl download: use npm there.

The archive is the same npm package plus the Node runtime it was built and tested with (about 46 MB packed, 150 MB unpacked: `bin/node`, or `bin\node.exe` on Windows) and a launcher. It is not a single-file executable: Node's single executable applications cannot load the package's files or act as the Node runtime the example sandbox starts, so the runtime ships as a plain `bin/node` next to the package.

```bash
v=0.11.0; f=openarc-$v-linux-x64.tar.gz
curl -LO https://github.com/TheMissenoOne/OpenArc/releases/download/v$v/$f
curl -LO https://github.com/TheMissenoOne/OpenArc/releases/download/v$v/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS     # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
tar -xzf $f -C ~/.local/opt                        # any folder; keep it in place
ln -s ~/.local/opt/openarc-$v-linux-x64/bin/openarc ~/.local/bin/openarc
openarc doctor
```

Windows: unpack the zip anywhere (Explorer, or `tar -xf openarc-<version>-win32-x64.zip` in a terminal), put its `bin` folder on `PATH`, and run `openarc doctor`. Check the download with `certutil -hashfile openarc-<version>-win32-x64.zip SHA256` against `SHA256SUMS`.

On macOS, a tarball downloaded with a browser is quarantined; `xattr -dr com.apple.quarantine <folder>` after unpacking, or download with `curl` as above.

What works, with the bundled Node and no other Node installed: `decompile` (JavaScript and TypeScript code runs in the sandbox with the bundled Node), `decompile --check`, `arc status`, `view`, `status`, `arch`, `concept`, `setup` and the wrapper it writes, the [[MCP]] server, and `doctor`. `tests/binary.check.ts` runs the download with no `node` on the `PATH` (decompile, `decompile --check`, `arc status`, an MCP tool call, `setup` and its wrapper) on each platform above, in CI and before each release. The sandbox tiers are the same as for npm ([[Safety Model]]); on Linux, install bubblewrap for the strong tier.

Limits:
- A code-first project (one whose sources import `open-arc`) still needs `npm i -D open-arc` in that project; the standalone `openarc` does not provide the package to your code or to `tsc`.
- The bundled Node is the one in the tarball, not yours. `sandbox.nodeBin` in [[Configuration]] still picks another one for the sandbox.
- `openarc setup` writes `.openarc/bin/openarc` pointing at the unpacked folder, as with npm it points at the install: move or delete that folder and run `setup` again.
- No automatic updates: download a newer archive.
- Windows: `openarc setup` writes sh scripts (the `.openarc/bin/openarc` wrapper, the guard hook, the MCP server entry), so it needs Git for Windows' `sh.exe` on `PATH` (`C:\Program Files\Git\bin`); without it, setup stops with a message saying so and writes nothing. The MCP entry starts `sh` by name, so the agent tool must find it on its own `PATH` too; that part is not tested with a real agent on Windows. There is no `.cmd` variant of these scripts.
- Windows has no OS sandbox: examples run in the `node` tier (Node's permission model only, `OARC-W046`), and Go code is refused unless you configure `unsafe-none` ([[Languages]]).
