import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvalRun, EvalRunMeta, EvalStore } from "./types.js";

export function createFsStore(rootDir: string): EvalStore {
  return {
    save: async (run: EvalRun): Promise<void> => {
      const filePath = pathFor(rootDir, run.name, run.id);
      await mkdir(dirname(filePath), { recursive: true });
      await Bun.write(filePath, JSON.stringify(run, null, 2));
    },
    load: async (runId: string): Promise<EvalRun | undefined> => {
      const found = await findRunFile(rootDir, runId);
      return found === undefined ? undefined : await readRun(found, runId);
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
  const text = await file.text();
  const run = JSON.parse(text) as EvalRun;
  // Defense-in-depth: reject any run whose stored id disagrees with the
  // requested id. Encoding is collision-free, so this should never trigger
  // for well-formed stores — but it guards against hand-edited files.
  if (expectedId !== undefined && run.id !== expectedId) return undefined;
  return run;
}

async function findRunFile(rootDir: string, runId: string): Promise<string | undefined> {
  const encoded = `${encode(runId)}.json`;
  const dirs = await safeReaddir(rootDir);
  for (const evalName of dirs) {
    const path = join(rootDir, evalName, encoded);
    if (await Bun.file(path).exists()) return path;
  }
  return undefined;
}

async function listMetas(rootDir: string, evalName: string): Promise<readonly EvalRunMeta[]> {
  const dir = join(rootDir, encode(evalName));
  const files = (await safeReaddir(dir)).filter((f) => f.endsWith(".json"));
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
