// Authoritative fake (spec §9.4). In-memory FsPort. init: { files?: { [path]: content } }.
// snapshot(): { files } with sorted keys.
import { defineFake, type Json } from "openarc";
import type { FsPort } from "../../src/types.ts";

export function memoryFs(init: Json | undefined): { fs: FsPort; files: Map<string, string> } {
  const seed = (init as { files?: Record<string, string> } | undefined)?.files ?? {};
  const files = new Map<string, string>(Object.entries(seed));
  const under = (dir: string) => [...files.keys()].filter((k) => k.startsWith(dir.replace(/\/$/, "") + "/"));
  const fs: FsPort = {
    async read(path) { return files.get(path) ?? null; },
    async write(path, data) { files.set(path, data); },
    async rename(from, to) {
      const v = files.get(from);
      if (v === undefined) throw new Error(`fs.memory: rename: no such file ${from}`);
      files.delete(from);
      files.set(to, v);
    },
    async remove(path) { files.delete(path); for (const k of under(path)) files.delete(k); },
    async list(dir) {
      const prefix = dir === "" || dir === "." ? "" : dir.replace(/\/$/, "") + "/";
      const names = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]!);
      return [...names].sort();
    },
    async createExclusive(path) {
      if (files.has(path)) return false;
      files.set(path, "");
      return true;
    },
  };
  return { fs, files };
}

export const sortedFiles = (files: Map<string, string>): Json =>
  Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export default defineFake<FsPort>((init) => {
  const { fs, files } = memoryFs(init);
  return { instance: fs, snapshot: () => ({ files: sortedFiles(files) }) };
});
