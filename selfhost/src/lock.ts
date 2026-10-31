// `.openarc/lock` housekeeping (spec §15). Hand-written. The lock file holds the PID of the openarc process that
// created it (realPorts.fs.createExclusive writes it), so a lock left by a process that died hard can be told apart
// from one that is really held. Used by `openarc compile`, `openarc extract` and `openarc watch`.
import { readFileSync, rmSync, statSync } from "node:fs";

const LOCK = ".openarc/lock";

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
export function clearStaleLock(root: string, warn: (line: string) => void): void {
  const path = `${root}/${LOCK}`;
  let text: string;
  try {
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
  rmSync(path, { force: true });
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
