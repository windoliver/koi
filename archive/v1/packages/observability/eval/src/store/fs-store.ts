/**
 * Filesystem-based eval store — saves/loads eval runs as JSON files.
 */

import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { EvalRun, EvalRunMeta, EvalStore, EvalSummary } from "../types.js";

export interface FsEvalStoreConfig {
  readonly baseDir: string;
}

export function createFsEvalStore(config: FsEvalStoreConfig): EvalStore {
  const { baseDir } = config;

  return {
    async save(run: EvalRun): Promise<void> {
      const dir = join(baseDir, run.name, "runs");
      await mkdir(dir, { recursive: true });

      const fullPath = join(dir, `${run.id}.json`);
      const summaryPath = join(dir, `${run.id}.summary.json`);
      const latestPath = join(baseDir, run.name, "latest.json");

      await atomicWrite(fullPath, JSON.stringify(run, null, 2));
      await atomicWrite(summaryPath, JSON.stringify(run.summary, null, 2));
      await atomicWrite(latestPath, JSON.stringify({ runId: run.id, ...run.summary }, null, 2));
    },

    async load(runId: string): Promise<EvalRun | undefined> {
      return loadRunById(baseDir, runId);
    },

    async latest(evalName: string): Promise<EvalRun | undefined> {
      const latestPath = join(baseDir, evalName, "latest.json");
      const file = Bun.file(latestPath);
      if (!(await file.exists())) return undefined;

      try {
        const content = await file.text();
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed === "object" && parsed !== null && "runId" in parsed) {
          const meta = parsed as Readonly<Record<string, unknown>>;
          if (typeof meta.runId === "string") {
            return loadRunById(baseDir, meta.runId);
          }
        }
        return undefined;
      } catch {
        return undefined;
      }
    },

    async list(evalName: string): Promise<readonly EvalRunMeta[]> {
      return listRunMetas(baseDir, evalName);
    },
  };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await Bun.write(tmpPath, content);
  await rename(tmpPath, filePath);
}

async function loadRunById(baseDir: string, runId: string): Promise<EvalRun | undefined> {
  try {
    const evalDirs = await readdir(baseDir);
    for (const evalName of evalDirs) {
      const filePath = join(baseDir, evalName, "runs", `${runId}.json`);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const content = await file.text();
        return JSON.parse(content) as EvalRun;
      }
    }
  } catch {
    // Directory doesn't exist or read error
  }
  return undefined;
}

async function listRunMetas(baseDir: string, evalName: string): Promise<readonly EvalRunMeta[]> {
  const dir = join(baseDir, evalName, "runs");
  try {
    const files = await readdir(dir);
    const summaryFiles = files.filter((f) => f.endsWith(".summary.json"));
    const metas: EvalRunMeta[] = [];

    for (const file of summaryFiles) {
      try {
        const runId = file.replace(".summary.json", "");
        const content = await Bun.file(join(dir, file)).text();
        const summary = JSON.parse(content) as EvalSummary;

        // Attempt to read timestamp from the full run file
        let timestamp = "";
        try {
          const runFile = Bun.file(join(dir, `${runId}.json`));
          if (await runFile.exists()) {
            const runContent = await runFile.text();
            const run = JSON.parse(runContent) as { readonly timestamp?: string };
            timestamp = run.timestamp ?? "";
          }
        } catch {
          // Fall back to empty timestamp if run file is missing/corrupted
        }

        metas.push({
          id: runId,
          name: evalName,
          timestamp,
          passRate: summary.passRate,
          taskCount: summary.taskCount,
        });
      } catch {
        // Skip corrupted summary files
      }
    }
    return metas;
  } catch {
    return [];
  }
}
