import { mkdirSync, readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
 * process. Cross-process safety relies on atomic file writes (temp + rename)
 * for the file-backed implementation; readers may briefly observe stale
 * state, but never partial writes.
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

interface RegistryFile {
  readonly version: 1;
  readonly scopes: Record<string, { readonly containerId: string }>;
}

/**
 * Resolve the default scope-registry path:
 *   ${KOI_SANDBOX_DOCKER_STATE_DIR}/scopes.json, falling back to
 *   ${XDG_STATE_HOME ?? ~/.local/state}/koi-sandbox-docker/scopes.json.
 */
export function defaultScopeRegistryPath(): string {
  const overrideDir = process.env.KOI_SANDBOX_DOCKER_STATE_DIR;
  if (overrideDir !== undefined && overrideDir.length > 0) {
    return join(overrideDir, "scopes.json");
  }
  const xdg = process.env.XDG_STATE_HOME;
  const baseDir = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(baseDir, "koi-sandbox-docker", "scopes.json");
}

/**
 * File-backed registry. Reads the JSON ledger on each lookup so a peer
 * process's recent writes are visible. Writes are atomic via temp-file +
 * rename, so a crash mid-write leaves either the old or the new file —
 * never a half-written one. Within one process, an async chain serializes
 * mutations so concurrent record/forget calls cannot lose updates.
 *
 * Tolerates missing files and parse errors by treating the registry as
 * empty — better availability than failing a fresh sandbox bootstrap on
 * a corrupted state file.
 */
export function createFileScopeRegistry(opts?: { readonly path?: string }): ScopeRegistry {
  const filePath = opts?.path ?? defaultScopeRegistryPath();

  // `let` justified: the in-process write chain is mutated as we serialize
  // record/forget calls. Concurrent reads do not pass through this chain —
  // they re-read the file directly so a peer's writes are visible quickly.
  let writeChain: Promise<unknown> = Promise.resolve();

  function readFileSync_(): RegistryFile {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        (parsed as { version?: unknown }).version !== 1
      ) {
        return { version: 1, scopes: {} };
      }
      const scopes = (parsed as { scopes?: unknown }).scopes;
      if (scopes === null || typeof scopes !== "object") {
        return { version: 1, scopes: {} };
      }
      const out: Record<string, { readonly containerId: string }> = {};
      for (const [k, v] of Object.entries(scopes as Record<string, unknown>)) {
        if (
          v !== null &&
          typeof v === "object" &&
          typeof (v as { containerId?: unknown }).containerId === "string"
        ) {
          out[k] = { containerId: (v as { containerId: string }).containerId };
        }
      }
      return { version: 1, scopes: out };
    } catch {
      // Missing file or parse error → empty registry. A corrupted file should
      // not block sandbox bootstrap; the next successful write replaces it.
      return { version: 1, scopes: {} };
    }
  }

  async function writeAtomic(next: RegistryFile): Promise<void> {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    try {
      await rename(tmp, filePath);
    } catch (e: unknown) {
      // Best effort: don't leak the temp file on rename failure.
      try {
        await unlink(tmp);
      } catch {
        // ignore
      }
      throw e;
    }
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  return {
    record: (scope, containerId): Promise<void> =>
      enqueue(async () => {
        const cur = readFileSync_();
        const nextScopes = { ...cur.scopes, [scope]: { containerId } };
        await writeAtomic({ version: 1, scopes: nextScopes });
      }),
    lookup: async (scope): Promise<string | undefined> => {
      const cur = readFileSync_();
      return cur.scopes[scope]?.containerId;
    },
    forget: (scope): Promise<void> =>
      enqueue(async () => {
        const cur = readFileSync_();
        if (!(scope in cur.scopes)) return;
        const { [scope]: _dropped, ...rest } = cur.scopes;
        await writeAtomic({ version: 1, scopes: rest });
      }),
  };
}
