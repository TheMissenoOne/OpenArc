// `.openarc/lock` housekeeping (spec §15). Hand-written. The lock file holds the PID of the openarc process that
// created it (realPorts.fs.createExclusive writes it), so a lock left by a process that died hard can be told apart
// from one that is really held. Used by `openarc compile`, `openarc extract` and `openarc watch`.
import { linkSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";

const LOCK = ".openarc/lock";

/** Which lock file this is: the inode plus the holder's pid, or where a filesystem reports no inode (ino 0: FAT, some
 *  Windows and network filesystems) the pid plus mtime. The pid is always part of it: filesystems reuse a freed inode
 *  at once, so a replacement lock created right after the stale one was deleted can carry the same inode (seen on
 *  GitHub's Ubuntu runners). Exported for tests. */
export const statIdentity = (st: { ino: number; mtimeMs: number }, text: string): string =>
  st.ino ? `ino:${st.ino}|pid:${text}` : `pid:${text}@${st.mtimeMs}`;
export function lockIdentity(path: string): string {
  const st = statSync(path);
  return statIdentity(st, readFileSync(path, "utf8"));
}

/** process.kill(pid, 0) sends no signal: ESRCH means gone, EPERM means alive but someone else's. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes a lock whose holder is dead and reports it through warn. A lock without a PID (older openarc, or the
 *  instant between create and write) only counts as stale once it is 10 s old.
 *  ponytail: a recycled PID keeps a stale lock alive; the warning on E095 tells the user to delete it. */
export function clearStaleLock(root: string, warn: (line: string) => void, raced: () => void = () => {}): void {
  const path = `${root}/${LOCK}`;
  let text: string, id: string;
  try {
    id = lockIdentity(path); // before the read: a lock replaced in between shows its live pid, so it is kept
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const pid = Number.parseInt(text, 10);
  try {
    if (pid > 0 ? isAlive(pid) : Date.now() - statSync(path).mtimeMs < 10_000) return;
  } catch {
    return; // removed under us
  }
  // Two processes can judge the same lock stale, and one may already have created its own lock in its place. So the
  // stale file is taken with an atomic rename and deleted only if it is the same file (lockIdentity) that was judged.
  raced(); // tests: another process replaces the lock right here
  const taken = `${path}.stale-${process.pid}`;
  try {
    renameSync(path, taken);
  } catch {
    return; // another process took it first
  }
  if (lockIdentity(taken) !== id) {
    try {
      linkSync(taken, path); // a live lock: put it back (link fails rather than overwrite if yet another lock exists)
    } catch {
      // ponytail: a third process locked in this instant; the moved lock's holder then runs unlocked (needs 3 racers)
    }
    rmSync(taken, { force: true });
    return;
  }
  rmSync(taken, { force: true });
  warn(`warning: removed a stale ${LOCK} (${pid > 0 ? `pid ${pid} is not running` : "no pid, older than 10s"})`);
}

/** On a hard exit: drop the lock only if this process holds it. */
export function releaseOwnLock(root: string): void {
  try {
    if (readFileSync(`${root}/${LOCK}`, "utf8").trim() === String(process.pid)) rmSync(`${root}/${LOCK}`, { force: true });
  } catch {
    // no lock
  }
}
