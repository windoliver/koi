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
  test.skip("TODO(P4): same-client participants share one successful attach", async () => {
    void waitFor;
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
