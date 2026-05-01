import type {
  BackendDescriptor,
  KoiError,
  Result,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import type { SelectionDecision } from "./decision.js";

export interface RouterConfig {
  readonly adapters: readonly SandboxAdapter[];
  /** Consecutive failures before an adapter is marked `degraded`. Default 3. */
  readonly degradedThreshold?: number;
}

export interface SandboxRouter {
  readonly create: (
    profile: SandboxProfile,
  ) => Promise<
    Result<{ readonly instance: SandboxInstance; readonly decision: SelectionDecision }, KoiError>
  >;
  readonly describe: () => readonly BackendDescriptor[];
  readonly shutdown: () => Promise<void>;
}

interface AdapterRecord {
  readonly adapter: SandboxAdapter;
  state: BackendDescriptor["state"];
  consecutiveFailures: number;
}

const DEFAULT_DEGRADED_THRESHOLD = 3;

function describeRecord(rec: AdapterRecord): BackendDescriptor {
  const caps = rec.adapter.capabilities;
  if (caps === undefined) {
    return {
      name: rec.adapter.name,
      version: rec.adapter.version ?? "0.0.0",
      state: rec.state,
      capabilities: { supports: new Set(), priority: Number.MAX_SAFE_INTEGER },
    };
  }
  return {
    name: rec.adapter.name,
    version: rec.adapter.version ?? "0.0.0",
    state: rec.state,
    capabilities: caps,
  };
}

export function createSandboxRouter(config: RouterConfig): SandboxRouter {
  const records: AdapterRecord[] = config.adapters.map((adapter) => ({
    adapter,
    state: "created",
    consecutiveFailures: 0,
  }));
  let shutdownPromise: Promise<void> | undefined;

  // Kick off init() for every adapter concurrently. Failures move the adapter
  // to `terminated` permanently.
  for (const rec of records) {
    const init = rec.adapter.init;
    if (init === undefined) {
      rec.state = "ready";
      continue;
    }
    void (async () => {
      try {
        await init();
        if (rec.state === "created") rec.state = "ready";
      } catch {
        rec.state = "terminated";
      }
    })();
  }

  return {
    create: async (_profile) => {
      // Implemented in Task 10.
      const error: KoiError = {
        code: "INTERNAL",
        message: "router.create not yet implemented",
        retryable: false,
      };
      return { ok: false, error };
    },
    describe: () => records.map(describeRecord),
    shutdown: async () => {
      if (shutdownPromise !== undefined) {
        await shutdownPromise;
        return;
      }
      shutdownPromise = (async () => {
        await Promise.all(
          records.map(async (rec) => {
            if (rec.state === "terminated") return;
            const down = rec.adapter.shutdown;
            if (down !== undefined) {
              try {
                await down();
              } catch {
                // Shutdown failures still mark the adapter terminated.
              }
            }
            rec.state = "terminated";
          }),
        );
      })();
      await shutdownPromise;
    },
  };
}

// Suppress "unused" lint until Task 10 wires this. Keep the export so consumers
// can already import the threshold constant if needed.
export const __DEFAULT_DEGRADED_THRESHOLD: number = DEFAULT_DEGRADED_THRESHOLD;
