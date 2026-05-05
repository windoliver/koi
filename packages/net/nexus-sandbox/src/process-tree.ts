/**
 * Process-tree helpers for the nexus sandbox lifecycle.
 *
 * The default launch path is a wrapper command (e.g. `uvx --from nexus-ai-fs
 * nexusd`), so the actual listening process is typically a child of the pid
 * Bun.spawn returned. Listener-ownership verification and shutdown both
 * need to walk the process tree to handle that correctly.
 */

/**
 * Decide whether `pid` (or any of its descendants) is listening on `port`.
 * Returns:
 *   - `true`      → confirmed: our process tree owns the listener (proceed)
 *   - `false`     → confirmed: listener belongs to a different process tree,
 *                   OR no listener despite prior /health 200 (reject)
 *   - `undefined` → required tools (lsof or ps) genuinely unavailable;
 *                   caller falls through to weaker defenses (lock + probe
 *                   + child-exit settle).
 */
export const defaultVerifyListenerOwnership = async (
  pid: number,
  port: number,
): Promise<boolean | undefined> => {
  if (Bun.which("lsof") === null) return undefined;
  if (Bun.which("ps") === null) return undefined;
  let listenerPids: readonly number[];
  try {
    const proc = Bun.spawn(
      ["lsof", "-i", `tcp:${String(port)}`, "-sTCP:LISTEN", "-P", "-n", "-t"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0 && exitCode !== 1) return false;
    listenerPids = text
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return false;
  }
  if (listenerPids.length === 0) return false;
  for (const candidate of listenerPids) {
    if (await isDescendantOrSelf(candidate, pid)) return true;
  }
  return false;
};

/**
 * Walk the parent chain of `candidatePid` to see whether `ancestorPid` is
 * an ancestor (or the same process). Capped at 16 hops — typical wrapper
 * depth is 1-2; anything longer crossed a session boundary.
 */
export async function isDescendantOrSelf(
  candidatePid: number,
  ancestorPid: number,
): Promise<boolean> {
  if (candidatePid === ancestorPid) return true;
  let current = candidatePid;
  for (let depth = 0; depth < 16; depth++) {
    const ppid = await getParentPid(current);
    if (ppid === undefined) return false;
    if (ppid === ancestorPid) return true;
    if (ppid <= 1) return false;
    current = ppid;
  }
  return false;
}

async function getParentPid(pid: number): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(["ps", "-o", "ppid=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const ppid = Number.parseInt(text.trim(), 10);
    return Number.isFinite(ppid) && ppid >= 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Snapshot the full descendant-pid set rooted at `rootPid`. Used by
 * `stopSandbox` to collect the listener (a child of the wrapper) BEFORE
 * signalling so a wrapper that exits without forwarding SIGTERM cannot
 * orphan the real nexusd process under init.
 */
export async function snapshotDescendants(rootPid: number): Promise<readonly number[]> {
  if (Bun.which("pgrep") === null) return [];
  const all: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const children = await getDirectChildren(current);
    for (const child of children) {
      if (!seen.has(child)) {
        all.push(child);
        queue.push(child);
      }
    }
  }
  return all;
}

async function getDirectChildren(pid: number): Promise<readonly number[]> {
  try {
    const proc = Bun.spawn(["pgrep", "-P", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 1);
  } catch {
    return [];
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}
