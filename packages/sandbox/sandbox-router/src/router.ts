// packages/sandbox/sandbox-router/src/router.ts
import type {
  AdapterCapability,
  BackendDescriptor,
  CapabilityRequirements,
  KoiError,
  Result,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { buildDecision, type SelectionAttempt, type SelectionDecision } from "./decision.js";
import { matchAdapters } from "./match.js";

export interface RouterConfig {
  readonly adapters: readonly SandboxAdapter[];
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
const EMPTY_REQUIRED: ReadonlySet<AdapterCapability> = new Set();

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

function toKoiError(err: unknown): KoiError {
  return {
    code: "EXTERNAL",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
    cause: err,
  };
}

function sortRecords(records: readonly AdapterRecord[]): readonly AdapterRecord[] {
  return [...records].sort((a, b) => {
    const aReady = a.state === "ready" ? 0 : 1;
    const bReady = b.state === "ready" ? 0 : 1;
    if (aReady !== bReady) return aReady - bReady;
    const aPri = a.adapter.capabilities?.priority ?? Number.MAX_SAFE_INTEGER;
    const bPri = b.adapter.capabilities?.priority ?? Number.MAX_SAFE_INTEGER;
    return aPri - bPri;
  });
}

export function createSandboxRouter(config: RouterConfig): SandboxRouter {
  const threshold = config.degradedThreshold ?? DEFAULT_DEGRADED_THRESHOLD;
  const records: AdapterRecord[] = config.adapters.map((adapter) => ({
    adapter,
    state: "created",
    consecutiveFailures: 0,
  }));
  let shutdownPromise: Promise<void> | undefined;

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
    create: async (profile) => {
      const liveAdapters = records.filter((r) => r.state !== "terminated").map((r) => r.adapter);
      const requirements: CapabilityRequirements = profile.required ?? { required: EMPTY_REQUIRED };
      const matchResult = matchAdapters(liveAdapters, requirements);

      if (matchResult.matched.length === 0) {
        const error: KoiError = {
          code: "VALIDATION",
          message: "No registered adapter matches the requested capabilities",
          retryable: false,
          context: {
            reason: "no-adapter-matches",
            required: [...requirements.required],
            rejected: matchResult.rejected as unknown as readonly Record<string, unknown>[],
          },
        };
        return { ok: false, error };
      }

      const matchedRecords: AdapterRecord[] = matchResult.matched
        .map((adapter) => records.find((r) => r.adapter === adapter))
        .filter((r): r is AdapterRecord => r !== undefined);
      const sorted = sortRecords(matchedRecords);

      const attempts: SelectionAttempt[] = [];
      const errors: KoiError[] = [];

      for (const rec of sorted) {
        const stateAtAttempt = rec.state;
        try {
          const instance = await rec.adapter.create(profile);
          rec.consecutiveFailures = 0;
          if (rec.state === "degraded") rec.state = "ready";
          attempts.push({ adapter: rec.adapter.name, state: stateAtAttempt, ok: true });
          const decision = buildDecision({
            selected: describeRecord(rec),
            attempts,
            rejected: matchResult.rejected,
          });
          return { ok: true, value: { instance, decision } };
        } catch (err) {
          rec.consecutiveFailures++;
          if (rec.consecutiveFailures >= threshold && rec.state === "ready") {
            rec.state = "degraded";
          }
          const koiErr = toKoiError(err);
          attempts.push({
            adapter: rec.adapter.name,
            state: stateAtAttempt,
            ok: false,
            error: koiErr,
          });
          errors.push(koiErr);
        }
      }

      const last = errors[errors.length - 1];
      const error: KoiError = {
        code: "UNAVAILABLE",
        message: "All matched adapters failed at create()",
        retryable: false,
        cause: last,
        context: {
          reason: "all-adapters-failed",
          causedBy: errors as unknown as readonly Record<string, unknown>[],
        },
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
