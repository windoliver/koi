import { describe, expect, test } from "bun:test";
import type { KoiError, Result, WorkspaceId } from "@koi/core";
import { workspaceId } from "@koi/core";
import { createSpeculationController } from "./controller.js";
import type {
  SpeculationAcceptResult,
  SpeculationController,
  SpeculationForkAgent,
  SpeculationOverlay,
  SpeculationOverlayManager,
  SpeculationPresentedResult,
} from "./types.js";

function error(code: KoiError["code"], message: string): KoiError {
  return { code, message, retryable: false };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
} {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((err: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value: T): void => resolveFn?.(value),
    reject: (err: unknown): void => rejectFn?.(err),
  };
}

function makeOverlay(idText = "overlay-1"): SpeculationOverlay {
  return { id: workspaceId(idText), path: `/tmp/${idText}` };
}

function makeOverlayManager(): SpeculationOverlayManager & {
  readonly created: WorkspaceId[];
  readonly accepted: WorkspaceId[];
  readonly rejected: WorkspaceId[];
} {
  const created: WorkspaceId[] = [];
  const accepted: WorkspaceId[] = [];
  const rejected: WorkspaceId[] = [];
  return {
    created,
    accepted,
    rejected,
    async create(): Promise<Result<SpeculationOverlay, KoiError>> {
      const overlay = makeOverlay(`overlay-${created.length + 1}`);
      created.push(overlay.id);
      return { ok: true, value: overlay };
    },
    async accept(id: WorkspaceId): Promise<Result<SpeculationAcceptResult, KoiError>> {
      accepted.push(id);
      return { ok: true, value: { changedPaths: ["README.md"] } };
    },
    async reject(id: WorkspaceId): Promise<Result<void, KoiError>> {
      rejected.push(id);
      return { ok: true, value: undefined };
    },
  };
}

async function startOne(controller: SpeculationController): Promise<WorkspaceId> {
  const started = await controller.start({ agentName: "coder", description: "do work" });
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("not started");
  return started.id;
}

describe("createSpeculationController", () => {
  test("forks against an overlay and presents the speculative result", async () => {
    const overlays = makeOverlayManager();
    const presented: SpeculationPresentedResult[] = [];
    const fork: SpeculationForkAgent = async (request) => ({
      ok: true,
      output: `ran in ${request.overlay.id}`,
    });
    const controller = createSpeculationController({
      overlayManager: overlays,
      forkAgent: fork,
      presentResult: (result) => {
        presented.push(result);
      },
    });

    const id = await startOne(controller);
    await controller.waitForIdle();

    expect(presented).toEqual([{ id, overlay: makeOverlay("overlay-1"), output: `ran in ${id}` }]);
    expect(controller.snapshot(id)?.status).toBe("presented");
  });

  test("accept merges the overlay after presentation", async () => {
    const overlays = makeOverlayManager();
    const controller = createSpeculationController({
      overlayManager: overlays,
      forkAgent: async () => ({ ok: true, output: "ready" }),
    });

    const id = await startOne(controller);
    await controller.waitForIdle();
    const accepted = await controller.accept(id);

    expect(accepted).toEqual({ kind: "accepted", id, changedPaths: ["README.md"] });
    expect(overlays.accepted).toEqual([id]);
    expect(controller.snapshot(id)).toBeUndefined();
  });

  test("reject discards the overlay", async () => {
    const overlays = makeOverlayManager();
    const controller = createSpeculationController({
      overlayManager: overlays,
      forkAgent: async () => ({ ok: true, output: "ready" }),
    });

    const id = await startOne(controller);
    await controller.waitForIdle();
    const rejected = await controller.reject(id);

    expect(rejected).toEqual({ kind: "rejected", id });
    expect(overlays.rejected).toEqual([id]);
    expect(controller.snapshot(id)).toBeUndefined();
  });

  test("new user input cancels running speculation and rejects its overlay", async () => {
    const overlays = makeOverlayManager();
    const gate = deferred<{ readonly ok: true; readonly output: string }>();
    const signals: AbortSignal[] = [];
    const controller = createSpeculationController({
      overlayManager: overlays,
      forkAgent: async (request) => {
        signals.push(request.signal);
        return gate.promise;
      },
    });

    const id = await startOne(controller);
    const cancelled = await controller.cancelAll("new_user_input");
    gate.resolve({ ok: true, output: "late" });
    await controller.waitForIdle();

    expect(cancelled).toEqual([id]);
    expect(signals[0]?.aborted).toBe(true);
    expect(overlays.rejected).toEqual([id]);
    expect(controller.snapshot(id)).toBeUndefined();
  });

  test("resource limit falls back without creating a second overlay", async () => {
    const overlays = makeOverlayManager();
    const gate = deferred<{ readonly ok: true; readonly output: string }>();
    const controller = createSpeculationController({
      overlayManager: overlays,
      forkAgent: async () => gate.promise,
      maxConcurrent: 1,
    });

    const id = await startOne(controller);
    const second = await controller.start({ agentName: "coder", description: "second" });
    gate.resolve({ ok: true, output: "done" });
    await controller.waitForIdle();

    expect(second).toEqual({ kind: "fallback", reason: "resource_limit" });
    expect(overlays.created).toEqual([id]);
  });

  test("timeout aborts running speculation and discards the overlay", async () => {
    const overlays = makeOverlayManager();
    const signals: AbortSignal[] = [];
    const controller = createSpeculationController({
      overlayManager: overlays,
      forkAgent: async (request) => {
        signals.push(request.signal);
        return new Promise(() => {});
      },
      timeoutMs: 1,
    });

    const id = await startOne(controller);
    await controller.waitForIdle();

    expect(signals[0]?.aborted).toBe(true);
    expect(overlays.rejected).toEqual([id]);
    expect(controller.snapshot(id)).toBeUndefined();
  });

  test("fork failures silently reject the overlay and fall back", async () => {
    const overlays = makeOverlayManager();
    const controller = createSpeculationController({
      overlayManager: overlays,
      forkAgent: async () => ({ ok: false, error: error("EXTERNAL", "model unavailable") }),
    });

    const id = await startOne(controller);
    await controller.waitForIdle();

    expect(overlays.rejected).toEqual([id]);
    expect(controller.snapshot(id)).toBeUndefined();
  });

  test("overlay creation failure falls back before forking", async () => {
    let forked = false;
    const controller = createSpeculationController({
      overlayManager: {
        async create(): Promise<Result<SpeculationOverlay, KoiError>> {
          return { ok: false, error: error("EXTERNAL", "git unavailable") };
        },
        async accept(): Promise<Result<SpeculationAcceptResult, KoiError>> {
          throw new Error("accept should not run");
        },
        async reject(): Promise<Result<void, KoiError>> {
          throw new Error("reject should not run");
        },
      },
      forkAgent: async () => {
        forked = true;
        return { ok: true, output: "unused" };
      },
    });

    const started = await controller.start({ agentName: "coder", description: "do work" });

    expect(started).toEqual({
      kind: "fallback",
      reason: "overlay_create_failed",
      error: error("EXTERNAL", "git unavailable"),
    });
    expect(forked).toBe(false);
  });

  test("presentation failure discards the overlay", async () => {
    const overlays = makeOverlayManager();
    const controller = createSpeculationController({
      overlayManager: overlays,
      forkAgent: async () => ({ ok: true, output: "ready" }),
      presentResult: () => {
        throw new Error("ui gone");
      },
    });

    const id = await startOne(controller);
    await controller.waitForIdle();

    expect(overlays.rejected).toEqual([id]);
    expect(controller.snapshot(id)).toBeUndefined();
  });

  test("accept and reject failures return fallback responses", async () => {
    const overlays = makeOverlayManager();
    const acceptError = error("CONFLICT", "changed locally");
    const rejectError = error("EXTERNAL", "cleanup failed");
    const controller = createSpeculationController({
      overlayManager: {
        async create(): Promise<Result<SpeculationOverlay, KoiError>> {
          return { ok: true, value: makeOverlay("overlay-accept-fail") };
        },
        async accept(): Promise<Result<SpeculationAcceptResult, KoiError>> {
          return { ok: false, error: acceptError };
        },
        async reject(): Promise<Result<void, KoiError>> {
          return { ok: false, error: rejectError };
        },
      },
      forkAgent: async () => ({ ok: true, output: "ready" }),
    });

    const acceptId = await startOne(controller);
    await controller.waitForIdle();
    const accepted = await controller.accept(acceptId);
    const missingReject = await controller.reject(acceptId);

    expect(accepted).toEqual({
      kind: "fallback",
      id: acceptId,
      reason: "accept_failed",
      error: acceptError,
    });
    expect(missingReject).toEqual({ kind: "fallback", id: acceptId, reason: "cancelled" });
    expect(overlays.created.length).toBe(0);

    const rejectController = createSpeculationController({
      overlayManager: {
        async create(): Promise<Result<SpeculationOverlay, KoiError>> {
          return { ok: true, value: makeOverlay("overlay-reject-fail") };
        },
        async accept(): Promise<Result<SpeculationAcceptResult, KoiError>> {
          return { ok: true, value: { changedPaths: [] } };
        },
        async reject(): Promise<Result<void, KoiError>> {
          return { ok: false, error: rejectError };
        },
      },
      forkAgent: async () => ({ ok: true, output: "ready" }),
    });
    const rejectId = await startOne(rejectController);
    await rejectController.waitForIdle();
    const rejected = await rejectController.reject(rejectId);

    expect(rejected).toEqual({
      kind: "fallback",
      id: rejectId,
      reason: "reject_failed",
      error: rejectError,
    });
  });

  test("fork exceptions are treated as best-effort fallback", async () => {
    const overlays = makeOverlayManager();
    const controller = createSpeculationController({
      overlayManager: overlays,
      forkAgent: async () => {
        throw new Error("boom");
      },
    });

    const id = await startOne(controller);
    await controller.waitForIdle();

    expect(overlays.rejected).toEqual([id]);
    expect(controller.list()).toEqual([]);
  });
});
