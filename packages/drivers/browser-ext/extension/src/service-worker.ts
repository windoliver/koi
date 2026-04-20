import type { NmControlFrame } from "../../src/native-host/control-frames.js";
import { createAttachFsm } from "./attach-fsm.js";
import { createChunkSender } from "./chunking.js";
import { createNativeConnection } from "./connect-native.js";
import { createConsentManager } from "./consent.js";
import { createDetachedFrame } from "./detach-helpers.js";
import { createKeepalive } from "./keepalive.js";
import { createRouter } from "./router.js";
import { createExtensionStorage } from "./storage.js";

const storage = createExtensionStorage();
const consent = createConsentManager(storage);

let connectionReady = false;

let emitFrame: (frame: import("../../src/native-host/nm-frame.js").NmFrame) => void = () =>
  undefined;

const fsm = createAttachFsm({
  storage,
  consent,
  sendFrame: (frame) => emitFrame(frame as import("../../src/native-host/nm-frame.js").NmFrame),
});

const chunkSender = createChunkSender((frame) => emitFrame(frame));

async function bootstrap(): Promise<void> {
  const epoch = await storage.incrementHostBootCounter();
  await Promise.all([storage.getBrowserSessionId(), storage.getInstanceId()]);

  let routeControlFrame: (frame: NmControlFrame) => Promise<void> | void = () => undefined;
  const connection = createNativeConnection({
    storage,
    fsm,
    epoch,
    onFrame: async (frame) => {
      await router.routeFrame(frame);
    },
    onControlFrame: async (frame) => {
      await routeControlFrame(frame);
    },
    onPortReadyChanged: (ready) => {
      connectionReady = ready;
      if (ready) keepalive.startPortPing();
      else keepalive.stopPortPing();
    },
  });

  emitFrame = (frame) => connection.postFrame(frame);

  const keepalive = createKeepalive({
    ensureConnected: connection.ensureConnected,
    sendControlFrame: (frame) => connection.postControlFrame(frame),
  });

  const router = createRouter({
    fsm,
    storage,
    emitFrame,
    chunkSender,
  });

  routeControlFrame = async (frame): Promise<void> => {
    if (frame.kind === "ping") {
      connection.postControlFrame({ kind: "pong", seq: frame.seq });
    }
  };

  chrome.alarms.onAlarm.addListener((alarm) => {
    void keepalive.handleAlarm(alarm);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void fsm.handleTabRemoved(tabId);
  });
  chrome.webNavigation.onCommitted.addListener((details) => {
    const navigationDetails = {
      tabId: details.tabId,
      frameId: details.frameId,
      ...(details.documentId ? { documentId: details.documentId } : {}),
      ...(details.url ? { url: details.url } : {}),
    };
    void fsm.handleCommittedNavigation(navigationDetails);
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const session = fsm.getAttachedStates().find((state) => state.tabId === tabId);
    if (!session) return;
    chunkSender.sendEvent({
      kind: "cdp_event",
      sessionId: session.sessionId,
      eventId: crypto.randomUUID(),
      method,
      params,
    });
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const session = fsm.getAttachedStates().find((state) => state.tabId === tabId);
    if (!session) return;
    const detachedReason =
      reason === "target_closed"
        ? "tab_closed"
        : reason === "canceled_by_user"
          ? "devtools_opened"
          : "unknown";
    emitFrame(createDetachedFrame(session, detachedReason));
  });
  chrome.runtime.onInstalled.addListener(() => {
    void keepalive.installAlarm();
  });

  await keepalive.installAlarm();
  await connection.ensureConnected();
}

void bootstrap();

export function isConnectionReadyForTests(): boolean {
  return connectionReady;
}
