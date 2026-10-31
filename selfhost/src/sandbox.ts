import * as arc from "open-arc";
import type { HarnessSummary, SandboxConfig } from "./types.ts";

// ── sandbox.buildArgv ─────────────────────────────────────────── spec §9.2
// The expected argv was run for real on the target machine (Fedora 43, bwrap, Node 25.9.0):
// network → ENETUNREACH, fs write → ERR_ACCESS_DENIED, prlimit --as below 4 GiB → V8 crash.
type BuildArgv = (cfg: SandboxConfig) => string[];

export const buildArgvSpec = arc.defineRegion<BuildArgv>({
  id: "sandbox.buildArgv",
  intent: [
    "Return exactly the argv in the example, substituting cfg fields. bwrap provides network/fs/pid isolation;",
    "node --permission blocks fs-write, child processes and workers; prlimit caps CPU and address space; --max-old-space-size caps the heap.",
    "Bind nodePrefix read-only because nodeBin is often outside /usr (asdf, nvm, volta).",
  ],
  examples: [
    {
      args: [{
        stageDir: "/tmp/oa-stage",
        nodeBin: "/home/u/.asdf/installs/nodejs/25.9.0/bin/node",
        nodePrefix: "/home/u/.asdf/installs/nodejs/25.9.0",
        heapMb: 256,
        addressSpaceBytes: 4294967296,
        cpuSeconds: 10,
        regionId: "tasks.normalizeTitle",
      }],
      expected: [
        "bwrap", "--unshare-all", "--die-with-parent", "--new-session",
        "--ro-bind", "/tmp/oa-stage", "/work",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/home/u/.asdf/installs/nodejs/25.9.0", "/home/u/.asdf/installs/nodejs/25.9.0",
        "--symlink", "usr/lib64", "/lib64",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/bin", "/bin",
        "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev", "--chdir", "/work",
        "prlimit", "--as=4294967296", "--cpu=10",
        "/home/u/.asdf/installs/nodejs/25.9.0/bin/node",
        "--permission", "--allow-fs-read=/work", "--max-old-space-size=256",
        "/work/.openarc/harness.mjs", "tasks.normalizeTitle",
      ],
    },
  ],
});

// @openarc:begin sandbox.buildArgv
export const buildArgv: BuildArgv = (cfg) => {
  const args: string[] = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", cfg.stageDir, "/work", "--ro-bind", "/usr", "/usr", "--ro-bind", cfg.nodePrefix, cfg.nodePrefix, "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/lib", "/lib", "--symlink", "usr/bin", "/bin", "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev", "--chdir", "/work", "prlimit", "--as=" + cfg.addressSpaceBytes, "--cpu=" + cfg.cpuSeconds, cfg.nodeBin, "--permission", "--allow-fs-read=/work", "--max-old-space-size=" + cfg.heapMb, "/work/.openarc/harness.mjs", cfg.regionId];
  return args;
};
// @openarc:end sandbox.buildArgv

// ── sandbox.readHarnessOutput ─────────────────────────────────── spec §9.3
type ReadHarnessOutput = (stdout: string) => HarnessSummary;

export const readHarnessOutputSpec = arc.defineRegion<ReadHarnessOutput>({
  id: "sandbox.readHarnessOutput",
  intent: [
    "stdout is JSON lines: {name, ok, actual?} per example, then a final {done: n}. Blank lines are ignored.",
    "complete = a {done} line was seen and n equals the number of outcome lines. Generated code can process.exit() mid-run, so a missing done line means incomplete.",
    "A non-JSON line counts as a failure {name: '<unparseable>', ok: false, actual: <line>}.",
  ],
  examples: [
    {
      args: ["{\"name\":\"a\",\"ok\":true}\n{\"name\":\"b\",\"ok\":false,\"actual\":3}\n{\"done\":2}\n"],
      expected: { complete: true, passed: 1, failed: [{ name: "b", ok: false, actual: 3 }] },
    },
    {
      name: "killed by process.exit",
      args: ["{\"name\":\"a\",\"ok\":true}\n"],
      expected: { complete: false, passed: 1, failed: [] },
    },
    {
      args: ["garbage\n{\"done\":0}\n"],
      expected: { complete: false, passed: 0, failed: [{ name: "<unparseable>", ok: false, actual: "garbage" }] },
    },
    { args: [""], expected: { complete: false, passed: 0, failed: [] } },
  ],
});

// @openarc:begin sandbox.readHarnessOutput
export const readHarnessOutput: ReadHarnessOutput = (stdout) => arc.todo("sandbox.readHarnessOutput");
// @openarc:end sandbox.readHarnessOutput
