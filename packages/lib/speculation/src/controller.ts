import type { WorkspaceId } from "@koi/core";
import type {
  SpeculationAcceptResponse,
  SpeculationController,
  SpeculationControllerConfig,
  SpeculationFallbackReason,
  SpeculationOverlay,
  SpeculationPresentedResult,
  SpeculationRejectResponse,
  SpeculationSnapshot,
  SpeculationStartResult,
  StartSpeculationRequest,
} from "./types.js";

interface ActiveSpeculation {
  readonly id: WorkspaceId;
  readonly overlay: SpeculationOverlay;
  readonly abortController: AbortController;
  readonly clearTimer: () => void;
  readonly status: SpeculationSnapshot["status"];
  readonly output?: string | undefined;
  readonly fallbackReason?: SpeculationFallbackReason | undefined;
}

function makeTimeoutPromise(
  timeoutMs: number | undefined,
  controller: AbortController,
): {
  readonly promise: Promise<"timeout"> | undefined;
  readonly clear: () => void;
} {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return { promise: undefined, clear: () => {} };
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => {
      controller.abort("timeout");
      resolve("timeout");
    }, timeoutMs);
  });
  return {
    promise,
    clear: (): void => clearTimeout(timeoutHandle),
  };
}

export function createSpeculationController(
  config: SpeculationControllerConfig,
): SpeculationController {
  const maxConcurrent = config.maxConcurrent ?? 1;
  const active = new Map<WorkspaceId, ActiveSpeculation>();
  const inFlight = new Map<WorkspaceId, Promise<void>>();

  function updateEntry(
    id: WorkspaceId,
    updates: Partial<Pick<ActiveSpeculation, "fallbackReason" | "output" | "status">>,
  ): ActiveSpeculation | undefined {
    const current = active.get(id);
    if (current === undefined) return undefined;
    const next = { ...current, ...updates };
    active.set(id, next);
    return next;
  }

  async function cleanup(id: WorkspaceId, reason: SpeculationFallbackReason): Promise<void> {
    const entry = updateEntry(id, {
      status: reason === "cancelled" ? "cancelled" : "fallback",
      fallbackReason: reason,
    });
    if (entry === undefined) return;
    entry.abortController.abort(reason);
    entry.clearTimer();
    await config.overlayManager.reject(id);
    active.delete(id);
  }

  async function runSpeculation(
    entry: ActiveSpeculation,
    request: StartSpeculationRequest,
    timeoutPromise: Promise<"timeout"> | undefined,
  ): Promise<void> {
    try {
      const forkPromise = config.forkAgent({
        description: request.description,
        agentName: request.agentName,
        overlay: entry.overlay,
        signal: entry.abortController.signal,
        ...(request.spawnRequest !== undefined ? { spawnRequest: request.spawnRequest } : {}),
      });
      const result =
        timeoutPromise === undefined
          ? await forkPromise
          : await Promise.race([forkPromise, timeoutPromise]);

      if (result === "timeout") {
        await cleanup(entry.id, "timeout");
        return;
      }
      if (!result.ok) {
        await cleanup(entry.id, "fork_failed");
        return;
      }
      if (entry.abortController.signal.aborted) {
        await cleanup(entry.id, "cancelled");
        return;
      }
      updateEntry(entry.id, { output: result.output, status: "presented" });
      const presented: SpeculationPresentedResult = {
        id: entry.id,
        overlay: entry.overlay,
        output: result.output,
      };
      try {
        await config.presentResult?.(presented);
      } catch {
        await cleanup(entry.id, "present_failed");
      }
    } catch {
      await cleanup(entry.id, "fork_failed").catch(() => {});
    } finally {
      entry.clearTimer();
    }
  }

  function snapshotEntry(entry: ActiveSpeculation): SpeculationSnapshot {
    return {
      id: entry.id,
      overlay: entry.overlay,
      status: entry.status,
      ...(entry.output !== undefined ? { output: entry.output } : {}),
      ...(entry.fallbackReason !== undefined ? { fallbackReason: entry.fallbackReason } : {}),
    };
  }

  return {
    async start(request: StartSpeculationRequest): Promise<SpeculationStartResult> {
      if (active.size >= maxConcurrent) return { kind: "fallback", reason: "resource_limit" };
      const overlay = await config.overlayManager.create();
      if (!overlay.ok) {
        return { kind: "fallback", reason: "overlay_create_failed", error: overlay.error };
      }
      const abortController = new AbortController();
      const timeout = makeTimeoutPromise(config.timeoutMs, abortController);
      const entry: ActiveSpeculation = {
        id: overlay.value.id,
        overlay: overlay.value,
        abortController,
        status: "running",
        clearTimer: timeout.clear,
      };
      active.set(entry.id, entry);
      const done = runSpeculation(entry, request, timeout.promise).finally(() => {
        inFlight.delete(entry.id);
      });
      inFlight.set(entry.id, done);
      return { kind: "started", id: entry.id, overlay: entry.overlay };
    },

    async accept(id: WorkspaceId): Promise<SpeculationAcceptResponse> {
      const entry = active.get(id);
      if (entry === undefined) {
        return { kind: "fallback", id, reason: "cancelled" };
      }
      entry.abortController.abort("accepted");
      entry.clearTimer();
      await inFlight.get(id)?.catch(() => {});
      const accepted = await config.overlayManager.accept(id);
      active.delete(id);
      if (!accepted.ok) {
        return {
          kind: "fallback",
          id,
          reason: "accept_failed",
          error: accepted.error,
        };
      }
      return { kind: "accepted", id, changedPaths: accepted.value.changedPaths };
    },

    async reject(id: WorkspaceId): Promise<SpeculationRejectResponse> {
      const entry = active.get(id);
      if (entry === undefined) {
        return { kind: "fallback", id, reason: "cancelled" };
      }
      entry.abortController.abort("rejected");
      entry.clearTimer();
      await inFlight.get(id)?.catch(() => {});
      const rejected = await config.overlayManager.reject(id);
      active.delete(id);
      if (!rejected.ok) {
        return { kind: "fallback", id, reason: "reject_failed", error: rejected.error };
      }
      return { kind: "rejected", id };
    },

    async cancelAll(): Promise<readonly WorkspaceId[]> {
      const ids = [...active.keys()];
      await Promise.all(ids.map((id) => cleanup(id, "cancelled").catch(() => {})));
      return ids;
    },

    snapshot(id: WorkspaceId): SpeculationSnapshot | undefined {
      const entry = active.get(id);
      return entry === undefined ? undefined : snapshotEntry(entry);
    },

    list(): readonly SpeculationSnapshot[] {
      return [...active.values()].map(snapshotEntry);
    },

    async waitForIdle(): Promise<void> {
      await Promise.all([...inFlight.values()].map((done) => done.catch(() => {})));
    },
  };
}
