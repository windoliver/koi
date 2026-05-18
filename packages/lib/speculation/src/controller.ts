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

class SpeculationControllerState {
  private readonly active = new Map<WorkspaceId, ActiveSpeculation>();
  private readonly inFlight = new Map<WorkspaceId, Promise<void>>();
  private readonly config: SpeculationControllerConfig;
  private readonly maxConcurrent: number;

  constructor(config: SpeculationControllerConfig) {
    this.config = config;
    this.maxConcurrent = config.maxConcurrent ?? 1;
  }

  controller(): SpeculationController {
    return {
      start: (request) => this.start(request),
      accept: (id) => this.accept(id),
      reject: (id) => this.reject(id),
      cancelAll: () => this.cancelAll(),
      snapshot: (id) => this.snapshot(id),
      list: () => this.list(),
      waitForIdle: () => this.waitForIdle(),
    };
  }

  private updateEntry(
    id: WorkspaceId,
    updates: Partial<Pick<ActiveSpeculation, "fallbackReason" | "output" | "status">>,
  ): ActiveSpeculation | undefined {
    const current = this.active.get(id);
    if (current === undefined) return undefined;
    const next = { ...current, ...updates };
    this.active.set(id, next);
    return next;
  }

  private async cleanup(id: WorkspaceId, reason: SpeculationFallbackReason): Promise<void> {
    const entry = this.updateEntry(id, {
      status: reason === "cancelled" ? "cancelled" : "fallback",
      fallbackReason: reason,
    });
    if (entry === undefined) return;
    entry.abortController.abort(reason);
    entry.clearTimer();
    await this.config.overlayManager.reject(id);
    this.active.delete(id);
  }

  private async runSpeculation(
    entry: ActiveSpeculation,
    request: StartSpeculationRequest,
    timeoutPromise: Promise<"timeout"> | undefined,
  ): Promise<void> {
    try {
      const result = await this.runFork(entry, request, timeoutPromise);
      if (result === "timeout") return await this.cleanup(entry.id, "timeout");
      if (!result.ok) return await this.cleanup(entry.id, "fork_failed");
      if (entry.abortController.signal.aborted) return await this.cleanup(entry.id, "cancelled");
      await this.presentForkResult(entry, result.output);
    } catch {
      await this.cleanup(entry.id, "fork_failed").catch(() => {});
    } finally {
      entry.clearTimer();
    }
  }

  private runFork(
    entry: ActiveSpeculation,
    request: StartSpeculationRequest,
    timeoutPromise: Promise<"timeout"> | undefined,
  ) {
    const forkPromise = this.config.forkAgent({
      description: request.description,
      agentName: request.agentName,
      overlay: entry.overlay,
      signal: entry.abortController.signal,
      ...(request.spawnRequest !== undefined ? { spawnRequest: request.spawnRequest } : {}),
    });
    return timeoutPromise === undefined ? forkPromise : Promise.race([forkPromise, timeoutPromise]);
  }

  private async presentForkResult(entry: ActiveSpeculation, output: string): Promise<void> {
    this.updateEntry(entry.id, { output, status: "presented" });
    const presented: SpeculationPresentedResult = { id: entry.id, overlay: entry.overlay, output };
    try {
      await this.config.presentResult?.(presented);
    } catch {
      await this.cleanup(entry.id, "present_failed");
    }
  }

  private snapshotEntry(entry: ActiveSpeculation): SpeculationSnapshot {
    return {
      id: entry.id,
      overlay: entry.overlay,
      status: entry.status,
      ...(entry.output !== undefined ? { output: entry.output } : {}),
      ...(entry.fallbackReason !== undefined ? { fallbackReason: entry.fallbackReason } : {}),
    };
  }

  private async start(request: StartSpeculationRequest): Promise<SpeculationStartResult> {
    if (this.active.size >= this.maxConcurrent)
      return { kind: "fallback", reason: "resource_limit" };
    const overlay = await this.config.overlayManager.create();
    if (!overlay.ok) {
      return { kind: "fallback", reason: "overlay_create_failed", error: overlay.error };
    }
    const abortController = new AbortController();
    const timeout = makeTimeoutPromise(this.config.timeoutMs, abortController);
    const entry: ActiveSpeculation = {
      id: overlay.value.id,
      overlay: overlay.value,
      abortController,
      status: "running",
      clearTimer: timeout.clear,
    };
    this.active.set(entry.id, entry);
    const done = this.runSpeculation(entry, request, timeout.promise).finally(() => {
      this.inFlight.delete(entry.id);
    });
    this.inFlight.set(entry.id, done);
    return { kind: "started", id: entry.id, overlay: entry.overlay };
  }

  private async accept(id: WorkspaceId): Promise<SpeculationAcceptResponse> {
    const entry = this.active.get(id);
    if (entry === undefined) return { kind: "fallback", id, reason: "cancelled" };
    entry.abortController.abort("accepted");
    entry.clearTimer();
    await this.inFlight.get(id)?.catch(() => {});
    const accepted = await this.config.overlayManager.accept(id);
    this.active.delete(id);
    if (!accepted.ok) {
      return { kind: "fallback", id, reason: "accept_failed", error: accepted.error };
    }
    return { kind: "accepted", id, changedPaths: accepted.value.changedPaths };
  }

  private async reject(id: WorkspaceId): Promise<SpeculationRejectResponse> {
    const entry = this.active.get(id);
    if (entry === undefined) return { kind: "fallback", id, reason: "cancelled" };
    entry.abortController.abort("rejected");
    entry.clearTimer();
    await this.inFlight.get(id)?.catch(() => {});
    const rejected = await this.config.overlayManager.reject(id);
    this.active.delete(id);
    if (!rejected.ok) {
      return { kind: "fallback", id, reason: "reject_failed", error: rejected.error };
    }
    return { kind: "rejected", id };
  }

  private async cancelAll(): Promise<readonly WorkspaceId[]> {
    const ids = [...this.active.keys()];
    await Promise.all(ids.map((id) => this.cleanup(id, "cancelled").catch(() => {})));
    return ids;
  }

  private snapshot(id: WorkspaceId): SpeculationSnapshot | undefined {
    const entry = this.active.get(id);
    return entry === undefined ? undefined : this.snapshotEntry(entry);
  }

  private list(): readonly SpeculationSnapshot[] {
    return [...this.active.values()].map((entry) => this.snapshotEntry(entry));
  }

  private async waitForIdle(): Promise<void> {
    await Promise.all([...this.inFlight.values()].map((done) => done.catch(() => {})));
  }
}

export function createSpeculationController(
  config: SpeculationControllerConfig,
): SpeculationController {
  return new SpeculationControllerState(config).controller();
}
