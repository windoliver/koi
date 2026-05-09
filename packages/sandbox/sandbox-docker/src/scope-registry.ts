import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-scope ownership ledger consulted by `findOrCreate` before reattaching.
 *
 * Why this exists: a Docker daemon is a shared trust boundary. Any actor with
 * daemon access can create a container with `koi.sandbox.scope=<scope>` and a
 * matching `koi.sandbox.profile-hash` label — both inputs are deterministic
 * functions of inputs the attacker can observe. Without an unforgeable
 * provenance marker, label-only reuse would let a peer hijack a scope.
 *
 * The registry stores the container ID we ourselves received from
 * `createContainer(...)` for each scope. Reuse requires the daemon-side
 * scope-labeled container's ID to match the recorded ID. When no record
 * exists for a scope, the adapter refuses to reattach to any pre-existing
 * scope-labeled container — it either creates fresh (and records the ID) or,
 * on a name conflict for a brand-new scope, fails closed with a security
 * error rather than blindly attach to a stranger.
 *
 * Implementations must be safe to call from multiple async tasks within one
 * process AND across processes sharing the same backing store.
 */
export interface ScopeRegistry {
  /** Record the container ID we created for a scope. Overwrites any prior entry. */
  readonly record: (scope: string, containerId: string) => Promise<void>;
  /** Look up the container ID we previously recorded for a scope. */
  readonly lookup: (scope: string) => Promise<string | undefined>;
  /** Drop the entry for a scope. Idempotent — no error if the scope is unknown. */
  readonly forget: (scope: string) => Promise<void>;
  /**
   * Compare-and-swap delete: drop the entry only if it currently maps to
   * `expectedContainerId`. Returns true when the entry was matching and was
   * removed, false when no entry exists OR the recorded ID differs.
   *
   * Why this exists: blind `forget(scope)` is not safe across processes.
   * Process A removing the old container and process B recording a fresh
   * replacement can interleave such that A's trailing `forget` deletes B's
   * brand-new ownership record, leaving a live replacement classified as
   * an unowned stranger. CAS-by-id eliminates that window: the per-id
   * file-name encoding makes the delete atomic against another writer
   * recording a different id.
   */
  readonly forgetIfMatches: (scope: string, expectedContainerId: string) => Promise<boolean>;
}

/**
 * In-memory registry — process-local. Loses all entries on restart, so it
 * provides intra-process security but no cross-session persistence. Useful
 * for tests or short-lived adapters; production deployments that need
 * persistent scopes should use the file-backed registry.
 */
export function createInMemoryScopeRegistry(): ScopeRegistry {
  const map = new Map<string, string>();
  return {
    record: async (scope, containerId): Promise<void> => {
      map.set(scope, containerId);
    },
    lookup: async (scope): Promise<string | undefined> => map.get(scope),
    forget: async (scope): Promise<void> => {
      map.delete(scope);
    },
    forgetIfMatches: async (scope, expectedContainerId): Promise<boolean> => {
      if (map.get(scope) !== expectedContainerId) return false;
      map.delete(scope);
      return true;
    },
  };
}

/**
 * Resolve the default scope-registry directory:
 *   ${KOI_SANDBOX_DOCKER_STATE_DIR}/scopes, falling back to
 *   ${XDG_STATE_HOME ?? ~/.local/state}/koi-sandbox-docker/scopes.
 *
 * Each scope is stored as its own file inside this directory so concurrent
 * writes to different scopes never touch the same bytes — eliminating the
 * cross-process read-modify-write race that a single combined ledger would
 * have.
 */
export function defaultScopeRegistryDir(): string {
  const overrideDir = process.env.KOI_SANDBOX_DOCKER_STATE_DIR;
  if (overrideDir !== undefined && overrideDir.length > 0) {
    return join(overrideDir, "scopes");
  }
  const xdg = process.env.XDG_STATE_HOME;
  const baseDir = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(baseDir, "koi-sandbox-docker", "scopes");
}

/**
 * File-backed registry using a per-scope file layout. Each scope key is
 * hashed (sha256, hex) and stored at `<dir>/<hash>.scope` containing the
 * container ID as plain text.
 *
 * Why per-scope files (not a single JSON ledger): a single combined ledger
 * requires read-modify-write on every record/forget. Two cooperating
 * processes touching different scopes would race — both read the old file,
 * both write back, last writer silently drops the other's entry, and a
 * legitimate container ends up unverified by the registry.
 *
 * With one file per scope, concurrent writes for different scopes never
 * touch the same bytes; writes for the same scope are serialized by the
 * adapter's per-scope async serializer (intra-process) and by Docker's
 * deterministic --name conflict + retry (cross-process), so the file system
 * never sees competing writers for the same scope file.
 *
 * Writes are atomic via temp-file + rename, so a crash mid-write leaves
 * either the old file or the new file — never a half-written one.
 *
 * Tolerates missing files and read errors by treating the entry as absent.
 */
function isFsNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

export function createFileScopeRegistry(opts?: { readonly dir?: string }): ScopeRegistry {
  const dir = opts?.dir ?? defaultScopeRegistryDir();

  function scopeHash(scope: string): string {
    return createHash("sha256").update(scope, "utf8").digest("hex");
  }
  function idHash(containerId: string): string {
    return createHash("sha256").update(containerId, "utf8").digest("hex").slice(0, 32);
  }
  function entryPath(scope: string, containerId: string): string {
    // Filename encodes the (scope, containerId) pair so an unlink is an
    // atomic compare-and-swap-by-id: a stale forgetIfMatches cannot delete
    // a different process's freshly-recorded entry because that entry lives
    // at a different path.
    return join(dir, `${scopeHash(scope)}.${idHash(containerId)}.scope`);
  }
  function entryPattern(scope: string): string {
    return `${scopeHash(scope)}.`;
  }

  async function listEntries(scope: string): Promise<readonly string[]> {
    const prefix = entryPattern(scope);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e: unknown) {
      // Directory genuinely missing → no entries; other errors must surface
      // so a permission fault on the state dir does not silently look empty.
      if (isFsNotFound(e)) return [];
      throw e;
    }
    return names.filter((n) => n.startsWith(prefix) && n.endsWith(".scope"));
  }

  return {
    record: async (scope, containerId): Promise<void> => {
      mkdirSync(dir, { recursive: true });
      const target = entryPath(scope, containerId);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      // Content is the raw container ID so lookup can recover it without
      // reversing the hash. The filename hash is the CAS key; the content
      // is the value.
      await writeFile(tmp, containerId, { mode: 0o600 });
      try {
        await rename(tmp, target);
      } catch (e: unknown) {
        try {
          await unlink(tmp);
        } catch {
          // ignore — best effort cleanup
        }
        throw e;
      }
      // Sweep stale (scope, otherId) entries left over from a prior record.
      // Best effort: a concurrent peer's brand-new entry that lands between
      // listEntries() and unlink() is racy here, but that's a same-scope
      // double-record (already pathological — the deterministic --name
      // ensures only one container exists per scope cluster-wide).
      const stale = await listEntries(scope);
      const targetName = `${scopeHash(scope)}.${idHash(containerId)}.scope`;
      for (const n of stale) {
        if (n === targetName) continue;
        try {
          await unlink(join(dir, n));
        } catch (e: unknown) {
          if (!isFsNotFound(e)) throw e;
        }
      }
    },
    lookup: async (scope): Promise<string | undefined> => {
      const entries = await listEntries(scope);
      if (entries.length === 0) return undefined;
      // During a record() sweep multiple `<scopeHash>.<idHash>.scope` files
      // may briefly exist — the new entry plus stale ones being unlinked.
      // Iterate ALL matches and return the first successful read so a
      // sweep-in-progress that deletes one candidate cannot make a
      // legitimate fresh entry look absent. ENOENT on any single file
      // means it was just swept; try the next.
      for (const name of entries) {
        try {
          const raw = await readFile(join(dir, name), "utf-8");
          const trimmed = raw.trim();
          if (trimmed.length > 0) return trimmed;
        } catch (e: unknown) {
          if (isFsNotFound(e)) continue;
          throw e;
        }
      }
      return undefined;
    },
    forget: async (scope): Promise<void> => {
      const entries = await listEntries(scope);
      for (const n of entries) {
        try {
          await unlink(join(dir, n));
        } catch (e: unknown) {
          if (!isFsNotFound(e)) throw e;
        }
      }
    },
    forgetIfMatches: async (scope, expectedContainerId): Promise<boolean> => {
      // Atomic CAS by filename: if another process recorded a DIFFERENT id
      // for this scope, that entry lives at a different path and our
      // unlink does not touch it. ENOENT means either no entry or a
      // different id is recorded — both safely "did not match".
      try {
        await unlink(entryPath(scope, expectedContainerId));
        return true;
      } catch (e: unknown) {
        if (isFsNotFound(e)) return false;
        throw e;
      }
    },
  };
}
