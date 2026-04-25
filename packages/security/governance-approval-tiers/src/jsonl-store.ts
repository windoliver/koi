import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { computeGrantKey } from "@koi/hash";
import { applyAliases } from "./aliases.js";
import type { AliasSpec, ApprovalQuery, ApprovalStore, PersistedApproval } from "./types.js";

export interface JsonlApprovalStoreConfig {
  readonly path: string;
  readonly aliases?: readonly AliasSpec[];
  /**
   * Maximum bytes per appended row. Rows above this are rejected by
   * `append` rather than written, so a malicious or buggy caller cannot
   * generate a record larger than the kernel's atomic-write threshold
   * and risk interleaving under concurrent writers.
   *
   * Default 4096 — matches the conservative single-page write size that
   * every common POSIX filesystem (APFS, ext4, xfs, tmpfs) issues as one
   * physical write under O_APPEND.
   */
  readonly maxRowBytes?: number;
}

const DEFAULT_MAX_ROW_BYTES = 4096;

function isPersistedApproval(x: unknown): x is PersistedApproval {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.kind === "string" &&
    typeof r.agentId === "string" &&
    typeof r.payload === "object" &&
    r.payload !== null &&
    !Array.isArray(r.payload) &&
    typeof r.grantKey === "string" &&
    typeof r.grantedAt === "number"
  );
}

export function createJsonlApprovalStore(config: JsonlApprovalStoreConfig): ApprovalStore {
  const aliases = config.aliases ?? [];
  const maxRowBytes = config.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES;
  let writeQueue: Promise<void> = Promise.resolve();

  async function readAll(): Promise<readonly PersistedApproval[]> {
    // Catch every read-side failure (path is a directory, permission
    // change between exists() and text(), torn truncation under a hot
    // writer). Fall through to an empty list so `match` returns undefined
    // and the caller sees the original ok:"ask" verdict — the user is
    // re-prompted instead of having the backend evaluation throw and
    // surface as a generic POLICY_VIOLATION.
    let text: string;
    try {
      const file = Bun.file(config.path);
      if (!(await file.exists())) return [];
      text = await file.text();
    } catch (err) {
      console.warn(
        `[governance-approval-tiers] approvals file read failed (${config.path}); falling through to ask`,
        err,
      );
      return [];
    }
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
    // O_APPEND (via fs.appendFile) makes the kernel seek-to-end on every
    // write(). On POSIX regular files, a single write() syscall of a
    // small buffer is dispatched as one physical write — the kernel does
    // not split it, and concurrent O_APPEND writers serialise via the
    // file's append lock. Bounded rows therefore interleave cleanly at
    // line boundaries with no inter-process race. The earlier
    // read-modify-write strategy lost ~30% of writes under 2-process
    // contention; O_APPEND with a row size guard is the fix.
    await mkdir(dirname(config.path), { recursive: true });
    await appendFile(config.path, `${line}\n`);
  }

  return {
    async append(grant) {
      // Canonicalise on append so historical grants written under an
      // OLD payload value still match queries that arrive with the NEW
      // value after a migration. We rewrite the payload via aliases and
      // recompute grantKey from the canonical form. The original
      // (un-aliased) grantKey is preserved on `aliasOf` so an audit
      // trail can reconstruct the pre-migration record.
      const canonical = applyAliases(grant.kind, grant.payload, aliases);
      const aliased = canonical !== grant.payload;
      const stored: PersistedApproval = aliased
        ? {
            kind: grant.kind,
            agentId: grant.agentId,
            payload: canonical,
            grantKey: computeGrantKey(grant.kind, canonical),
            grantedAt: grant.grantedAt,
            aliasOf: grant.grantKey,
          }
        : grant;

      const line = JSON.stringify(stored);
      if (Buffer.byteLength(line, "utf8") + 1 > maxRowBytes) {
        // +1 for the trailing newline. Refuse oversized rows — see
        // maxRowBytes config doc for atomicity rationale.
        throw new Error(
          `[governance-approval-tiers] persisted grant exceeds maxRowBytes (${maxRowBytes}); refusing to append`,
        );
      }
      // Recover the queue past prior failures: chain from a swallowed
      // tail so a single rejected writeLine does not poison every later
      // append. Callers still observe THIS append's outcome via the
      // returned promise, so transient EACCES/ENOSPC for one row never
      // becomes a process-lifetime durability outage.
      const next = writeQueue.catch(() => undefined).then(() => writeLine(line));
      writeQueue = next.catch(() => undefined);
      await next;
    },

    async match(query: ApprovalQuery) {
      const canonical = applyAliases(query.kind, query.payload, aliases);
      const targetKey = computeGrantKey(query.kind, canonical);
      const entries = await readAll();
      for (const entry of entries) {
        if (entry.agentId !== query.agentId) continue;
        if (entry.grantKey === targetKey) return entry;
      }
      return undefined;
    },

    async load() {
      return readAll();
    },
  };
}
