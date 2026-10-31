// Sandbox tier selection and the argv of every tier except bwrap (spec §9.2). Hand-written.
// bwrap (Linux) keeps its argv in the sandbox.buildArgv region; this module picks the tier for this machine and builds
// the others: sandbox-exec (macOS), node (Node's permission model only; Windows and the fallback everywhere), container
// (podman/docker, only when asked for) and unsafe-none (only when asked for, by that name).
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, relative, isAbsolute } from "node:path";
import type { SandboxTier } from "./types.ts";

export type Isolation = "auto" | SandboxTier;
export const ISOLATIONS: readonly Isolation[] = ["auto", "bwrap", "sandbox-exec", "node", "container", "unsafe-none"];

/** `.openarc/harness.mjs` in the stage. The stage root is argv[3]; bwrap and container mount it at /work and pass none. */
export const HARNESS_ENTRY = 'import { main } from "open-arc/harness";\nawait main(process.argv[3] ?? "/work", process.argv[2]);\n';

export interface Tools {
  bwrap: boolean; // bwrap and prlimit present AND an unprivileged user namespace works (Ubuntu 24.04 can restrict it)
  sandboxExec: boolean;
  container: string | null; // "podman" | "docker"
}

export type TierChoice = { tier: SandboxTier; reason: string } | { error: string };

/** Pure: the tier `want` resolves to on `platform` with `tools`. "auto" never picks container or unsafe-none. */
export function chooseTier(want: Isolation, platform: string, tools: Tools): TierChoice {
  switch (want) {
    case "unsafe-none":
      return { tier: want, reason: "configured (no sandbox)" };
    case "node":
      return { tier: want, reason: "configured" };
    case "bwrap":
      return platform === "linux" && tools.bwrap ? { tier: want, reason: "configured" } : { error: "bwrap-unavailable" };
    case "sandbox-exec":
      return platform === "darwin" && tools.sandboxExec ? { tier: want, reason: "configured" } : { error: "sandbox-exec-unavailable" };
    case "container":
      return tools.container ? { tier: want, reason: `configured (${tools.container})` } : { error: "no-podman-or-docker" };
    case "auto":
      if (platform === "linux" && tools.bwrap) return { tier: "bwrap", reason: "auto: bwrap works" };
      if (platform === "darwin" && tools.sandboxExec) return { tier: "sandbox-exec", reason: "auto: macOS sandbox-exec" };
      return { tier: "node", reason: `auto: no OS sandbox on ${platform}${platform === "linux" ? " (bwrap/prlimit missing or user namespaces restricted)" : ""}` };
  }
}

const onPath = (name: string): boolean =>
  (process.env.PATH ?? "").split(delimiter).some((d) => d && (existsSync(join(d, name)) || (process.platform === "win32" && existsSync(join(d, `${name}.exe`)))));

let probed: Tools | undefined;
/** What this machine has. Probed once per process; bwrap is actually run once, because Ubuntu 24.04's AppArmor
 *  restriction on user namespaces leaves the binary present but unusable. */
export function probeTools(): Tools {
  if (probed) return probed;
  const bwrap = process.platform === "linux" && onPath("bwrap") && onPath("prlimit") &&
    spawnSync("bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], { stdio: "ignore", timeout: 10_000 }).status === 0;
  return (probed = {
    bwrap,
    sandboxExec: process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"),
    container: onPath("podman") ? "podman" : onPath("docker") ? "docker" : null,
  });
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const realNative = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};
const inside = (dir: string, p: string) => {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** What the harness may read: the stage, the project's node_modules (found by walking up from the stage, which lives
 *  inside the project) and the real paths of symlinked packages that point elsewhere (file: deps, npm link). Real paths,
 *  because Node checks permissions on them and macOS puts temp dirs behind /var -> /private/var. */
export function readPaths(root: string, stageDir: string): string[] {
  const nm = join(root, "node_modules");
  const out = [real(stageDir)];
  if (existsSync(nm)) out.push(...linkedPackages(nm));
  // Windows: Node's loader keeps 8.3 short names (RUNNER~1) that the native realpath expands; grant both spellings
  return [...new Set(out.flatMap((p) => [p, realNative(p)]))];
}

function linkedPackages(nm: string): string[] {
  const nmReal = real(nm);
  const out = [nmReal];
  const entries = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const name of entries(nm)) {
    const paths = name.startsWith("@") ? entries(join(nm, name)).map((n) => join(nm, name, n)) : [join(nm, name)];
    for (const p of paths) {
      try {
        if (!lstatSync(p).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const target = real(p);
      if (!out.some((o) => inside(o, target))) out.push(target);
    }
  }
  return out;
}

const sbplString = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** macOS sandbox-exec profile (SBPL), later rules win: no network, no writes outside /dev and the temp dir, and no
 *  file contents under the home directory except the stage, node_modules and Node itself. Everything else (system
 *  libraries, dyld, mach services) stays allowed, as in Bazel's darwin sandbox. */
export function sbplProfile(reads: string[], nodePrefix: string): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath "/dev") (subpath ${sbplString(real(tmpdir()))}))`,
    `(deny file-read-data (subpath ${sbplString(real(homedir()))}))`,
    `(allow file-read-data ${[...reads, real(nodePrefix)].map((p) => `(subpath ${sbplString(p)})`).join(" ")})`,
  ].join("\n");
}

export interface TierArgs {
  root: string; // project root (OS path)
  stageDir: string; // OS path
  nodeBin: string;
  nodePrefix: string;
  heapMb: number;
  cpuSeconds: number;
  regionId: string;
  containerImage?: string;
}

/** argv for every tier but bwrap (sandbox.buildArgv). The node flags are bwrap's minus bwrap and prlimit: no
 *  --allow-net/-child-process/-worker/-addons/-wasi/-fs-write. Wall-clock timeout: the caller's (ports.proc.run). */
export function tierArgv(tier: Exclude<SandboxTier, "bwrap">, a: TierArgs): string[] {
  const stage = real(a.stageDir);
  const heap = `--max-old-space-size=${a.heapMb}`;
  const harness = [join(stage, ".openarc", "harness.mjs"), a.regionId, stage];
  if (tier === "unsafe-none") return [a.nodeBin, heap, ...harness];
  if (tier === "container") {
    const engine = probeTools().container ?? "podman";
    return [
      engine, "run", "--rm", "--network=none", "--security-opt", "label=disable",
      "-v", `${stage}:/work:ro`, "-v", `${join(a.root, "node_modules")}:/work/node_modules:ro`, "-w", "/work",
      a.containerImage ?? `docker.io/library/node:${process.versions.node}-slim`,
      // killing the podman/docker client does not stop the container: it stops itself
      "timeout", "-s", "KILL", String(a.cpuSeconds + 5),
      "node", "--permission", "--allow-fs-read=/work", heap, "/work/.openarc/harness.mjs", a.regionId,
    ];
  }
  const reads = readPaths(a.root, stage);
  const node = [a.nodeBin, "--permission", ...reads.map((p) => `--allow-fs-read=${p}`), heap, ...harness];
  return tier === "sandbox-exec" ? ["sandbox-exec", "-p", sbplProfile(reads, a.nodePrefix), ...node] : node;
}

/** Node's permission model denies network only from v25.0.0 (--allow-net); before that the node tier has no network isolation. */
export const nodeBlocksNetwork = (version = process.versions.node) => Number(version.split(".")[0]) >= 25;
