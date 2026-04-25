import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { computeGrantKey } from "@koi/hash";
import { applyAliases } from "./aliases.js";
import type { AliasSpec, ApprovalQuery, ApprovalStore, PersistedApproval } from "./types.js";

export interface JsonlApprovalStoreConfig {
  readonly path: string;
  readonly aliases?: readonly AliasSpec[];
}

function isPersistedApproval(x: unknown): x is PersistedApproval {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.kind === "string" &&
    typeof r.payload === "object" &&
    r.payload !== null &&
    !Array.isArray(r.payload) &&
    typeof r.grantKey === "string" &&
    typeof r.grantedAt === "number"
  );
}

export function createJsonlApprovalStore(config: JsonlApprovalStoreConfig): ApprovalStore {
  const aliases = config.aliases ?? [];
  let writeQueue: Promise<void> = Promise.resolve();

  async function readAll(): Promise<readonly PersistedApproval[]> {
    const file = Bun.file(config.path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const out: PersistedApproval[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isPersistedApproval(parsed)) out.push(parsed);
        // else: malformed — skip.
      } catch {
        // Malformed line — skip.
      }
    }
    return out;
  }

  async function writeLine(line: string): Promise<void> {
    // O_APPEND + a single write() of a sub-PIPE_BUF-sized payload is atomic
    // on POSIX: the kernel seeks-to-end and writes in one step. A row is a
    // few hundred bytes, well under the 4 KiB PIPE_BUF threshold, so two
    // processes appending concurrently cannot interleave mid-line or lose
    // each other's writes. Earlier read-modify-write lost ~30% of writes
    // under 2-process race; O_APPEND is the fix.
    await mkdir(dirname(config.path), { recursive: true });
    await appendFile(config.path, `${line}\n`);
  }

  return {
    async append(grant) {
      writeQueue = writeQueue.then(() => writeLine(JSON.stringify(grant)));
      await writeQueue;
    },

    async match(query: ApprovalQuery) {
      const canonical = applyAliases(query.kind, query.payload, aliases);
      const targetKey = computeGrantKey(query.kind, canonical);
      const entries = await readAll();
      for (const entry of entries) {
        if (entry.grantKey === targetKey) return entry;
      }
      return undefined;
    },

    async load() {
      return readAll();
    },
  };
}
