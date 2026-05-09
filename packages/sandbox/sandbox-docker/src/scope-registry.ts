import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
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
export function createFileScopeRegistry(opts?: { readonly dir?: string }): ScopeRegistry {
  const dir = opts?.dir ?? defaultScopeRegistryDir();

  function pathFor(scope: string): string {
    // Hash so arbitrary scope strings (containing slashes, colons, etc.)
    // become safe filenames. Scope strings are not secrets; the hash is
    // about path safety, not confidentiality.
    const hash = createHash("sha256").update(scope, "utf8").digest("hex");
    return join(dir, `${hash}.scope`);
  }

  return {
    record: async (scope, containerId): Promise<void> => {
      mkdirSync(dir, { recursive: true });
      const target = pathFor(scope);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
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
    },
    lookup: async (scope): Promise<string | undefined> => {
      try {
        const raw = await readFile(pathFor(scope), "utf-8");
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      } catch {
        // Missing file or any read error → entry absent.
        return undefined;
      }
    },
    forget: async (scope): Promise<void> => {
      try {
        await unlink(pathFor(scope));
      } catch {
        // Idempotent: missing file is success.
      }
    },
  };
}
