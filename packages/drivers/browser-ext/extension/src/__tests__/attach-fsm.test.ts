import { describe, expect, test } from "bun:test";
import { createAttachFsm } from "../attach-fsm.js";
import { createConsentManager } from "../consent.js";
import { createExtensionStorage } from "../storage.js";
import { installChromeStub } from "./chrome-stub.js";

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("attach FSM", () => {
  test("participants coalesce: same-lease duplicate attaches share one successful attach", async () => {
    const controller = installChromeStub();
    controller.framesByTab.set(42, [
      { parentFrameId: -1, documentId: "doc-1", url: "https://example.com/page" },
    ]);
    const storage = createExtensionStorage();
    await storage.setAlwaysGrant("https://example.com", new Date().toISOString());

    // Hold chrome.debugger.attach in flight so the second handleAttach races into
    // the existing "attaching" state and becomes a participant.
    let releaseAttach: () => void = () => {};
    const attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    controller.debuggerState.attachImpl = async (tabId: number): Promise<void> => {
      controller.debuggerState.attachedTabs.add(tabId);
      await attachGate;
    };

    const sentFrames: unknown[] = [];
    const fsm = createAttachFsm({
      storage,
      consent: createConsentManager(storage),
      sendFrame: (frame) => sentFrames.push(frame),
    });

    const lease = "a".repeat(32);
    const reqA = "11111111-1111-4111-8111-111111111111";
    const reqB = "22222222-2222-4222-8222-222222222222";

    const firstAttach = fsm.handleAttach({
      kind: "attach",
      tabId: 42,
      leaseToken: lease,
      attachRequestId: reqA,
    });
    await waitFor(() => controller.debuggerState.attachedTabs.has(42));
    const secondAttach = fsm.handleAttach({
      kind: "attach",
      tabId: 42,
      leaseToken: lease,
      attachRequestId: reqB,
    });

    releaseAttach();
    await Promise.all([firstAttach, secondAttach]);

    const acks = sentFrames.filter(
      (f): f is { kind: string; ok: boolean; sessionId: string; attachRequestId: string } =>
        typeof f === "object" && f !== null && (f as { kind?: string }).kind === "attach_ack",
    );
    expect(acks.length).toBe(2);
    expect(acks.every((a) => a.ok === true)).toBe(true);
    expect(acks[0]?.sessionId).toBe(acks[1]?.sessionId ?? "");
    const reqIds = acks.map((a) => a.attachRequestId).sort();
    expect(reqIds).toEqual([reqA, reqB].sort());
  });

  test("different-lease attach while attaching is rejected as already_attached", async () => {
    const controller = installChromeStub();
    controller.framesByTab.set(42, [
      { parentFrameId: -1, documentId: "doc-1", url: "https://example.com/page" },
    ]);
    const storage = createExtensionStorage();
    await storage.setAlwaysGrant("https://example.com", new Date().toISOString());

    let releaseAttach: () => void = () => {};
    const attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    controller.debuggerState.attachImpl = async (tabId: number): Promise<void> => {
      controller.debuggerState.attachedTabs.add(tabId);
      await attachGate;
    };

    const sentFrames: unknown[] = [];
    const fsm = createAttachFsm({
      storage,
      consent: createConsentManager(storage),
      sendFrame: (frame) => sentFrames.push(frame),
    });

    const leaseA = "a".repeat(32);
    const leaseB = "b".repeat(32);

    const first = fsm.handleAttach({
      kind: "attach",
      tabId: 42,
      leaseToken: leaseA,
      attachRequestId: "11111111-1111-4111-8111-111111111111",
    });
    await waitFor(() => controller.debuggerState.attachedTabs.has(42));

    await fsm.handleAttach({
      kind: "attach",
      tabId: 42,
      leaseToken: leaseB,
      attachRequestId: "22222222-2222-4222-8222-222222222222",
    });

    releaseAttach();
    await first;

    const rejection = sentFrames.find(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as { kind?: string }).kind === "attach_ack" &&
        (f as { leaseToken?: string }).leaseToken === leaseB,
    );
    expect(rejection).toBeDefined();
    expect((rejection as { ok: boolean }).ok).toBe(false);
    expect((rejection as { reason?: string }).reason).toBe("already_attached");
  });

  test("consent_required_if_missing fails without prompting", async () => {
    installChromeStub().framesByTab.set(42, [
      { parentFrameId: -1, documentId: "doc-1", url: "https://example.com/page" },
    ]);
    const storage = createExtensionStorage();
    const sentFrames: unknown[] = [];
    const fsm = createAttachFsm({
      storage,
      consent: createConsentManager(storage),
      sendFrame: (frame) => sentFrames.push(frame),
    });

    await fsm.handleAttach({
      kind: "attach",
      tabId: 42,
      leaseToken: "f".repeat(32),
      attachRequestId: "11111111-1111-4111-8111-111111111111",
      reattach: "consent_required_if_missing",
    });

    expect(sentFrames).toContainEqual({
      kind: "attach_ack",
      ok: false,
      tabId: 42,
      leaseToken: "f".repeat(32),
      attachRequestId: "11111111-1111-4111-8111-111111111111",
      reason: "consent_required",
    });
  });

  test("private origins are rejected before prompting", async () => {
    const controller = installChromeStub();
    controller.framesByTab.set(42, [
      { parentFrameId: -1, documentId: "doc-1", url: "http://localhost:3000/" },
    ]);
    const storage = createExtensionStorage();
    const sentFrames: unknown[] = [];
    const fsm = createAttachFsm({
      storage,
      consent: createConsentManager(storage),
      sendFrame: (frame) => sentFrames.push(frame),
    });

    await fsm.handleAttach({
      kind: "attach",
      tabId: 42,
      leaseToken: "f".repeat(32),
      attachRequestId: "11111111-1111-4111-8111-111111111111",
    });

    expect(controller.notifications.created).toHaveLength(0);
    expect(sentFrames).toContainEqual({
      kind: "attach_ack",
      ok: false,
      tabId: 42,
      leaseToken: "f".repeat(32),
      attachRequestId: "11111111-1111-4111-8111-111111111111",
      reason: "private_origin",
    });
  });
});
