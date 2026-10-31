// Directory watching for `openarc watch` (spec §15). Hand-written. One NON-recursive fs.watch per directory: on
// Linux a recursive fs.watch stops reporting a file once it has been replaced by rename, which is exactly how
// txn.commit writes, so watch went blind to every file it had just compiled into.
import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";

export interface DirWatch {
  /** Re-create the watchers of these directories (project-relative; default all), e.g. after a commit replaced files. */
  rewatch(dirs?: Iterable<string>): void;
  close(): void;
}

/** Watches each of `dirs` (project-relative POSIX, missing ones skipped) and every subdirectory, now or later.
 *  `onChange` gets project-relative POSIX paths. ponytail: one inotify watch per directory, fine for src/ trees. */
export function watchDirs(root: string, dirs: string[], onChange: (rel: string) => void): DirWatch {
  const ws = new Map<string, FSWatcher>();
  const isDir = (rel: string) => {
    try {
      return statSync(`${root}/${rel}`).isDirectory();
    } catch {
      return false;
    }
  };
  const drop = (rel: string) => {
    for (const [d, w] of ws)
      if (d === rel || d.startsWith(`${rel}/`)) {
        w.close();
        ws.delete(d);
      }
  };
  const add = (rel: string) => {
    if (ws.has(rel) || !isDir(rel)) return;
    try {
      const w = watch(`${root}/${rel}`, (_e, f) => {
        if (!f) return;
        const p = `${rel}/${f}`;
        if (isDir(p)) add(p); // a new subdirectory
        else if (ws.has(p)) drop(p); // a watched subdirectory went away
        onChange(p);
      });
      w.on("error", () => drop(rel)); // the directory itself was removed
      ws.set(rel, w);
    } catch {
      return; // removed between the check and the watch
    }
    for (const name of readdirSync(`${root}/${rel}`)) add(`${rel}/${name}`);
  };
  for (const d of dirs) add(d);
  return {
    rewatch(changed = [...ws.keys()]) {
      for (const d of new Set(changed)) {
        ws.get(d)?.close();
        ws.delete(d);
        add(d);
      }
    },
    close() {
      for (const w of ws.values()) w.close();
      ws.clear();
    },
  };
}
