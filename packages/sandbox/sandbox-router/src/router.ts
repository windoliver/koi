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

// AdapterRecord — internal router bookkeeping. `state`, `consecutiveFailures`,
// and `init` are intentionally mutable (the router updates them as adapters
// succeed/fail). `init` is per-adapter so a hung init on one record never
// starves creates that target a different ready record.
interface AdapterRecord {
  readonly adapter: SandboxAdapter;
  state: BackendDescriptor["state"];
  consecutiveFailures: number;
  init: Promise<void> | undefined;
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

function buildRecords(adapters: readonly SandboxAdapter[]): AdapterRecord[] {
  return adapters.map((adapter) => ({
    adapter,
    state: "created" as BackendDescriptor["state"],
    consecutiveFailures: 0,
    init: undefined,
  }));
}

function startInits(records: readonly AdapterRecord[]): void {
  for (const rec of records) {
    const init = rec.adapter.init;
    if (init === undefined) {
      rec.state = "ready";
      continue;
    }
    rec.init = (async () => {
      try {
        await init();
        if (rec.state === "created") rec.state = "ready";
      } catch {
        rec.state = "terminated";
      } finally {
        rec.init = undefined;
      }
    })();
  }
}

function noMatchError(
  requirements: CapabilityRequirements,
  matchResult: ReturnType<typeof matchAdapters>,
): KoiError {
  return {
    code: "VALIDATION",
    message: "No registered adapter matches the requested capabilities",
    retryable: false,
    context: {
      reason: "no-adapter-matches",
      required: [...requirements.required],
      rejected: matchResult.rejected as unknown as readonly Record<string, unknown>[],
    },
  };
}

async function tryAdapters(
  sorted: readonly AdapterRecord[],
  matchResult: ReturnType<typeof matchAdapters>,
  profile: SandboxProfile,
  threshold: number,
): Promise<
  Result<{ readonly instance: SandboxInstance; readonly decision: SelectionDecision }, KoiError>
> {
  const attempts: SelectionAttempt[] = [];
  const errors: KoiError[] = [];
  for (const rec of sorted) {
    // teardownAdapters marks every record terminated before awaiting
    // adapter.shutdown(); skip any record a concurrent shutdown closed.
    if (rec.state === "terminated") continue;
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
      if (rec.consecutiveFailures >= threshold && rec.state === "ready") rec.state = "degraded";
      const koiErr = toKoiError(err);
      attempts.push({ adapter: rec.adapter.name, state: stateAtAttempt, ok: false, error: koiErr });
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
}

function isLive(rec: AdapterRecord): boolean {
  return rec.state !== "terminated";
}

async function settlePendingForRecords(records: readonly AdapterRecord[]): Promise<void> {
  const inits = records.map((r) => r.init).filter((p): p is Promise<void> => p !== undefined);
  if (inits.length > 0) await Promise.allSettled(inits);
}

async function selectAndCreate(
  records: readonly AdapterRecord[],
  profile: SandboxProfile,
  threshold: number,
  isClosing: () => boolean,
): Promise<
  Result<{ readonly instance: SandboxInstance; readonly decision: SelectionDecision }, KoiError>
> {
  if (isClosing()) {
    return {
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "sandbox-router: shutdown in progress, no new sandboxes can be created",
        retryable: false,
        context: { reason: "router-shutting-down" },
      },
    };
  }
  const requirements: CapabilityRequirements = profile.required ?? { required: EMPTY_REQUIRED };

  // Try any non-terminated candidate (ready, created, degraded) first — we
  // must not starve a successful adapter on a sibling's hung init. Degraded
  // adapters are kept in the candidate set so the priority-sort logic can
  // re-promote them on a successful create (the test contract enforces this).
  const liveAdapters = records.filter(isLive).map((r) => r.adapter) as readonly SandboxAdapter[];
  const firstPass = matchAdapters(liveAdapters, requirements);
  if (firstPass.matched.length > 0) {
    const matchedRecords = firstPass.matched
      .map((adapter) => records.find((r) => r.adapter === adapter))
      .filter((r): r is AdapterRecord => r !== undefined);
    return tryAdapters(sortRecords(matchedRecords), firstPass, profile, threshold);
  }

  // No live candidate matched — only now wait for any still-initializing
  // records to finish in case one of them comes online satisfying the match.
  await settlePendingForRecords(records);
  if (isClosing()) {
    return {
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "sandbox-router: shutdown in progress, no new sandboxes can be created",
        retryable: false,
        context: { reason: "router-shutting-down" },
      },
    };
  }
  const liveAfterInit = records.filter(isLive).map((r) => r.adapter);
  const matchResult = matchAdapters(liveAfterInit, requirements);
  if (matchResult.matched.length === 0) {
    return { ok: false, error: noMatchError(requirements, matchResult) };
  }
  const matchedRecords = matchResult.matched
    .map((adapter) => records.find((r) => r.adapter === adapter))
    .filter((r): r is AdapterRecord => r !== undefined);
  return tryAdapters(sortRecords(matchedRecords), matchResult, profile, threshold);
}

async function teardownAdapters(records: readonly AdapterRecord[]): Promise<void> {
  // Mark every record terminated FIRST so any in-flight create() that re-reads
  // state observes the closed router before invoking adapter.create().
  for (const rec of records) rec.state = "terminated";
  // Settle any in-flight init promises before invoking shutdown — otherwise
  // an adapter could observe shutdown() called before init() completes.
  await settlePendingForRecords(records);
  await Promise.all(
    records.map(async (rec) => {
      const down = rec.adapter.shutdown;
      if (down === undefined) return;
      try {
        await down();
      } catch {
        // Shutdown failures still leave the record terminated.
      }
    }),
  );
}

export function createSandboxRouter(config: RouterConfig): SandboxRouter {
  const threshold = config.degradedThreshold ?? DEFAULT_DEGRADED_THRESHOLD;
  const records = buildRecords(config.adapters);
  startInits(records);
  // let — closing flag is set the moment shutdown() is called so concurrent
  // create() requests fail fast instead of racing teardown.
  let closing = false;
  // let — assigned once on first shutdown call to provide idempotent deduplication
  let shutdownPromise: Promise<void> | undefined;
  return {
    create: (profile) => selectAndCreate(records, profile, threshold, () => closing),
    describe: () => records.map(describeRecord),
    shutdown: () => {
      if (shutdownPromise === undefined) {
        closing = true;
        shutdownPromise = teardownAdapters(records);
      }
      return shutdownPromise;
    },
  };
}
