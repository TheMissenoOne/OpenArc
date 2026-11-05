import * as arc from "open-arc";
import type { HarnessSummary, SandboxConfig } from "./types.ts";
import type { ExampleOutcome } from "./types.ts";

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
    "Bind each of cfg.extraReadPaths read-only at its own path, in order, after --dev /dev (so --tmpfs /tmp can't hide one under /tmp), and let node read each one (--allow-fs-read after /work).",
    "Copy the expected array of the first example literally in that order, replacing only its values with cfg fields; don't add, sort or move any element. nodePrefix's --ro-bind comes right after /usr's, before the --symlink entries.",
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
        extraReadPaths: [],
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
    {
      name: "symlinked node_modules",
      args: [{
        stageDir: "/tmp/oa-stage",
        nodeBin: "/usr/bin/node",
        nodePrefix: "/usr",
        heapMb: 256,
        addressSpaceBytes: 4294967296,
        cpuSeconds: 10,
        regionId: "a.b",
        extraReadPaths: ["/home/u/shared/node_modules", "/tmp/pkgs/core"],
      }],
      expected: [
        "bwrap", "--unshare-all", "--die-with-parent", "--new-session",
        "--ro-bind", "/tmp/oa-stage", "/work",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/lib64", "/lib64",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/bin", "/bin",
        "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev",
        "--ro-bind", "/home/u/shared/node_modules", "/home/u/shared/node_modules",
        "--ro-bind", "/tmp/pkgs/core", "/tmp/pkgs/core",
        "--chdir", "/work",
        "prlimit", "--as=4294967296", "--cpu=10",
        "/usr/bin/node",
        "--permission", "--allow-fs-read=/work", "--allow-fs-read=/home/u/shared/node_modules", "--allow-fs-read=/tmp/pkgs/core", "--max-old-space-size=256",
        "/work/.openarc/harness.mjs", "a.b",
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
    "complete = a {done} line was seen, n equals the number of outcome lines, and no outcome line follows the done line. Generated code can process.exit() mid-run, so a missing done line means incomplete;",
    "it also shares stdout, so an outcome after the done line means the marker was forged and the run is incomplete.",
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
    {
      name: "outcome after the done line",
      args: ["{\"done\":1}\n{\"name\":\"x\",\"ok\":true}\n"],
      expected: { complete: false, passed: 1, failed: [] },
    },
  ],
});

// @openarc:begin sandbox.readHarnessOutput
export const readHarnessOutput: ReadHarnessOutput = (stdout) => {
  const lines = stdout.split(/\n+/).filter(line => line.trim() !== "");
  const outcomes: ExampleOutcome[] = [];
  let doneCount = -1;
  let complete = false;

  for (const line of lines) {
    if (complete) {
      // Outcome after done line means incomplete
      complete = false;
    }
    try {
      const obj = JSON.parse(line);
      if (obj.done !== undefined) {
        if (typeof obj.done === "number") {
          doneCount = obj.done;
          complete = true;
        }
      } else {
        outcomes.push({
          name: obj.name || "<unparseable>",
          ok: obj.ok !== false,
          actual: obj.actual
        });
      }
    } catch {
      outcomes.push({
        name: "<unparseable>",
        ok: false,
        actual: line
      });
    }
  }

  const passed = outcomes.filter(o => o.ok).length;
  const failed = outcomes.filter(o => !o.ok);

  if (complete && outcomes.length === doneCount) {
    return { complete: true, passed, failed };
  }
  return { complete: false, passed, failed };
};
// @openarc:end sandbox.readHarnessOutput
