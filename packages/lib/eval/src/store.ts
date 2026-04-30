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
      const metas = await listMetas(rootDir, evalName);
      const top = metas[0];
      return top === undefined ? undefined : await readRun(pathFor(rootDir, evalName, top.id));
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
  return (
    typeof r["id"] === "string" &&
    typeof r["name"] === "string" &&
    typeof r["timestamp"] === "string" &&
    typeof r["summary"] === "object" &&
    r["summary"] !== null
  );
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
