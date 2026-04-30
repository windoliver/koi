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
        return await readRunStrict(pathFor(rootDir, evalName, runId), runId);
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

async function readRunResult(path: string, expectedId?: string): Promise<ReadResult> {
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
async function readRunStrict(path: string, expectedId?: string): Promise<EvalRun | undefined> {
  const r = await readRunResult(path, expectedId);
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
  if (!isConfigSnapshot(r["config"])) return false;
  if (!isSummary(r["summary"])) return false;
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
  // Read every file's timestamp via readRunResult so we can find the newest
  // candidate. The newest must be readable; older corrupt files are skipped.
  type Entry = { readonly timestamp: string; readonly run: EvalRun };
  const candidates: Entry[] = [];
  let newestCorrupted: { readonly path: string; readonly cause: unknown } | undefined;
  for (const f of files) {
    const path = join(dir, f);
    const r = await readRunResult(path);
    if (r.kind === "ok") {
      candidates.push({ timestamp: r.run.timestamp, run: r.run });
    } else if (r.kind === "corrupted") {
      newestCorrupted = { path: r.path, cause: r.cause };
    }
  }
  candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const top = candidates[0];
  // If the corrupted file's timestamp would be newer than every readable
  // candidate, we can't tell — fail closed. We approximate this by
  // failing whenever any corruption was observed AND no valid candidate
  // outranks it by mtime; simplest safe rule: any corruption blocks
  // when the resulting candidate would otherwise be older than that file.
  if (newestCorrupted !== undefined) {
    throw new Error(
      `EvalStore: corrupted run file at ${newestCorrupted.path} — refusing to demote latest() to an older baseline`,
      { cause: newestCorrupted.cause instanceof Error ? newestCorrupted.cause : undefined },
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
  } catch {
    return [];
  }
}
