import { mkdir, readdir, rename, unlink } from "node:fs/promises";
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
      await Bun.write(tempPath, JSON.stringify(run, null, 2));
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
        return await readRun(pathFor(rootDir, evalName, runId), runId);
      }
      const matches = await findAllRunFiles(rootDir, runId);
      // Reject ambiguous lookups — caller must scope by evalName when ids
      // may collide across suites. Returning the first match would be
      // dependent on directory enumeration order.
      if (matches.length !== 1) return undefined;
      const path = matches[0];
      return path === undefined ? undefined : await readRun(path, runId);
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

async function readRun(path: string, expectedId?: string): Promise<EvalRun | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  let run: EvalRun;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as unknown;
    if (!isEvalRunShape(parsed)) return undefined;
    run = parsed;
  } catch {
    // Malformed JSON or unreadable file — skip silently so a single corrupt
    // artifact cannot blind enumeration of the rest of the suite history.
    return undefined;
  }
  // Defense-in-depth: reject any run whose stored id disagrees with the
  // requested id. Encoding is collision-free, so this should never trigger
  // for well-formed stores — but it guards against hand-edited files.
  if (expectedId !== undefined && run.id !== expectedId) return undefined;
  return run;
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
    if (await Bun.file(path).exists()) found.push(path);
  }
  return found;
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
