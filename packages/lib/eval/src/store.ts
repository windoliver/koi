import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvalRun, EvalRunMeta, EvalStore } from "./types.js";

export function createFsStore(rootDir: string): EvalStore {
  return {
    save: async (run: EvalRun): Promise<void> => {
      const filePath = pathFor(rootDir, run.name, run.id);
      const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      await mkdir(dirname(filePath), { recursive: true });
      // Atomic write: stage to temp, rename into place. A crash between
      // steps leaves either the previous run or no file at the final path
      // — never a torn JSON document that would silently shadow newer
      // baselines.
      await writeFile(tempPath, JSON.stringify(run, null, 2), "utf8");
      try {
        await rename(tempPath, filePath);
      } catch (e: unknown) {
        await unlink(tempPath).catch(() => {
          // best-effort cleanup — surface the original failure below
        });
        throw e;
      }
    },
    load: async (runId: string, evalName?: string): Promise<EvalRun | undefined> => {
      if (evalName !== undefined) {
        return await readRunStrict(pathFor(rootDir, evalName, runId), runId, evalName);
      }
      const matches = await findAllRunFiles(rootDir, runId);
      // Reject ambiguous lookups — caller must scope by evalName when ids
      // may collide across suites. Returning the first match would be
      // dependent on directory enumeration order.
      if (matches.length !== 1) return undefined;
      const path = matches[0];
      return path === undefined ? undefined : await readRunStrict(path, runId);
    },
    latest: async (evalName: string): Promise<EvalRun | undefined> => {
      // Fail closed for the newest candidate so a corrupted top file
      // cannot silently demote selection to a stale baseline. Older files
      // are still skipped (history may legitimately have damaged
      // artifacts), but the latest must be readable or we throw.
      return findLatestStrict(rootDir, evalName);
    },
    list: async (evalName: string): Promise<readonly EvalRunMeta[]> => listMetas(rootDir, evalName),
  };
}

function pathFor(rootDir: string, evalName: string, runId: string): string {
  return join(rootDir, encode(evalName), `${encode(runId)}.json`);
}

// encodeURIComponent guarantees a one-to-one, collision-free mapping from
// arbitrary strings to safe path components. Decode mirrors it for listing.
function encode(s: string): string {
  return encodeURIComponent(s);
}

type ReadResult =
  | { readonly kind: "ok"; readonly run: EvalRun }
  | { readonly kind: "missing" }
  | { readonly kind: "corrupted"; readonly path: string; readonly cause: unknown };

async function readRunResult(
  path: string,
  expectedId?: string,
  expectedName?: string,
): Promise<ReadResult> {
  let run: EvalRun;
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!isEvalRunShape(parsed)) return { kind: "corrupted", path, cause: "shape mismatch" };
    run = parsed;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "corrupted", path, cause: e };
  }
  if (expectedId !== undefined && run.id !== expectedId) {
    return {
      kind: "corrupted",
      path,
      cause: `id mismatch (file: ${run.id}, expected: ${expectedId})`,
    };
  }
  // Bind stored JSON to its suite directory: if run.name disagrees with
  // the directory it was loaded from, the artifact is misplaced — treat
  // as corruption rather than silently accepting it as a baseline for
  // the wrong suite.
  if (expectedName !== undefined && run.name !== expectedName) {
    return {
      kind: "corrupted",
      path,
      cause: `name mismatch (file: ${run.name}, suite directory: ${expectedName})`,
    };
  }
  return { kind: "ok", run };
}

/**
 * Wrapper for callers that want only `EvalRun | undefined` and accept
 * silent corruption (used by listMetas/latest, where one bad file cannot
 * be allowed to blind the whole history).
 */
async function readRun(path: string, expectedId?: string): Promise<EvalRun | undefined> {
  const r = await readRunResult(path, expectedId);
  return r.kind === "ok" ? r.run : undefined;
}

/**
 * Strict variant for explicit load() calls: returns undefined for true
 * not-found, but throws for corruption so the regression gate fails
 * closed instead of silently degrading to "no_baseline".
 */
async function readRunStrict(
  path: string,
  expectedId?: string,
  expectedName?: string,
): Promise<EvalRun | undefined> {
  const r = await readRunResult(path, expectedId, expectedName);
  if (r.kind === "ok") return r.run;
  if (r.kind === "missing") return undefined;
  throw new Error(
    `EvalStore: corrupted run file at ${r.path} — ${r.cause instanceof Error ? r.cause.message : String(r.cause)}`,
    { cause: r.cause instanceof Error ? r.cause : undefined },
  );
}

function isEvalRunShape(v: unknown): v is EvalRun {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r["id"] !== "string") return false;
  if (typeof r["name"] !== "string") return false;
  if (typeof r["timestamp"] !== "string") return false;
  if (!Array.isArray(r["trials"])) return false;
  for (const t of r["trials"] as readonly unknown[]) {
    if (!isTrialShape(t)) return false;
  }
  if (!isConfigSnapshot(r["config"])) return false;
  if (!isSummary(r["summary"])) return false;
  return true;
}

function isTrialShape(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  if (typeof t["taskId"] !== "string") return false;
  if (typeof t["trialIndex"] !== "number") return false;
  if (!Array.isArray(t["transcript"])) return false;
  if (!Array.isArray(t["scores"])) return false;
  for (const s of t["scores"] as readonly unknown[]) {
    if (s === null || typeof s !== "object") return false;
    const sc = s as Record<string, unknown>;
    if (typeof sc["graderId"] !== "string") return false;
    if (typeof sc["score"] !== "number") return false;
    if (typeof sc["pass"] !== "boolean") return false;
  }
  if (t["metrics"] === null || typeof t["metrics"] !== "object") return false;
  const m = t["metrics"] as Record<string, unknown>;
  if (typeof m["totalTokens"] !== "number") return false;
  if (typeof m["durationMs"] !== "number") return false;
  if (t["status"] !== "pass" && t["status"] !== "fail" && t["status"] !== "error") return false;
  if (
    t["cancellation"] !== "n/a" &&
    t["cancellation"] !== "confirmed" &&
    t["cancellation"] !== "unconfirmed"
  ) {
    return false;
  }
  return true;
}

function isConfigSnapshot(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c["name"] === "string" &&
    typeof c["timeoutMs"] === "number" &&
    typeof c["passThreshold"] === "number" &&
    typeof c["taskCount"] === "number"
  );
}

function isSummary(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s["taskCount"] !== "number") return false;
  if (typeof s["trialCount"] !== "number") return false;
  if (typeof s["passRate"] !== "number") return false;
  if (typeof s["meanScore"] !== "number") return false;
  if (typeof s["errorCount"] !== "number") return false;
  if (!Array.isArray(s["byTask"])) return false;
  for (const t of s["byTask"] as readonly unknown[]) {
    if (t === null || typeof t !== "object") return false;
    const ts = t as Record<string, unknown>;
    if (typeof ts["taskId"] !== "string") return false;
    if (typeof ts["passRate"] !== "number") return false;
    if (typeof ts["meanScore"] !== "number") return false;
  }
  return true;
}

async function findLatestStrict(rootDir: string, evalName: string): Promise<EvalRun | undefined> {
  const dir = join(rootDir, encode(evalName));
  const files = (await safeReaddir(dir)).filter((f) => f.endsWith(".json") && !f.includes(".tmp-"));
  if (files.length === 0) return undefined;

  type OkEntry = { readonly path: string; readonly mtimeMs: number; readonly run: EvalRun };
  type BadEntry = { readonly path: string; readonly mtimeMs: number; readonly cause: unknown };
  const ok: OkEntry[] = [];
  const bad: BadEntry[] = [];
  for (const f of files) {
    const path = join(dir, f);
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    const r = await readRunResult(path, undefined, evalName);
    if (r.kind === "ok") ok.push({ path, mtimeMs, run: r.run });
    else if (r.kind === "corrupted") bad.push({ path, mtimeMs, cause: r.cause });
  }

  // Pick the newest valid run by run.timestamp (the documented contract);
  // mtime is only used to decide whether a corrupt file would have been
  // newer than the chosen baseline.
  ok.sort((a, b) => b.run.timestamp.localeCompare(a.run.timestamp));
  const top = ok[0];
  // Fail closed only when a corrupt artifact is newer (by mtime) than the
  // chosen baseline — i.e., the corruption could have shadowed a newer
  // run. Stale bad artifacts deeper in history are skipped silently.
  const newestBadMtime = bad.length === 0 ? -1 : Math.max(...bad.map((b) => b.mtimeMs));
  if (newestBadMtime !== -1 && (top === undefined || newestBadMtime >= top.mtimeMs)) {
    const culprit = bad.find((b) => b.mtimeMs === newestBadMtime);
    throw new Error(
      `EvalStore: corrupted run file at ${culprit?.path} — refusing to demote latest() to an older baseline`,
      { cause: culprit?.cause instanceof Error ? culprit.cause : undefined },
    );
  }
  return top?.run;
}

async function findAllRunFiles(rootDir: string, runId: string): Promise<readonly string[]> {
  const encoded = `${encode(runId)}.json`;
  const dirs = await safeReaddir(rootDir);
  const found: string[] = [];
  for (const evalName of dirs) {
    const path = join(rootDir, evalName, encoded);
    if (await fileExists(path)) found.push(path);
  }
  return found;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listMetas(rootDir: string, evalName: string): Promise<readonly EvalRunMeta[]> {
  const dir = join(rootDir, encode(evalName));
  const files = (await safeReaddir(dir)).filter((f) => f.endsWith(".json") && !f.includes(".tmp-"));
  const metas: EvalRunMeta[] = [];
  for (const f of files) {
    const run = await readRun(join(dir, f));
    if (run === undefined) continue;
    metas.push({
      id: run.id,
      name: run.name,
      timestamp: run.timestamp,
      passRate: run.summary.passRate,
      taskCount: run.summary.taskCount,
    });
  }
  metas.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return metas;
}

async function safeReaddir(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (e: unknown) {
    // Only suppress true not-found — propagate permission/IO errors so
    // callers can fail closed instead of silently degrading to "no
    // baseline" against a broken store.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
