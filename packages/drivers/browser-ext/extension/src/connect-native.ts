import { type NmControlFrame, NmControlFrameSchema } from "../../src/native-host/control-frames.js";
import { type NmFrame, NmFrameSchema } from "../../src/native-host/nm-frame.js";
import type { AttachFsm } from "./attach-fsm.js";
import type { ExtensionStorage } from "./storage.js";

const HOST_NAME = "com.koi.browser_ext";
const SUPPORTED_PROTOCOLS = [1] as const;
const MAX_QUEUED_FRAMES = 100;
const EXTENSION_VERSION = "0.1.0";

type ConnectionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "connecting";
      readonly epoch: number;
      readonly seq: number;
      readonly promise: Promise<void>;
    }
  | {
      readonly kind: "connected";
      readonly epoch: number;
      readonly seq: number;
      readonly port: chrome.runtime.Port;
    };

export interface NativeConnection {
  readonly ensureConnected: () => Promise<void>;
  readonly postFrame: (frame: NmFrame) => void;
  readonly postControlFrame: (frame: NmControlFrame) => void;
  readonly isPortReady: () => boolean;
}

function detectBrowserHint(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("brave")) return "Brave";
  if (ua.includes("chrome")) return "Google Chrome";
  return "";
}

export function createNativeConnection(deps: {
  readonly storage: ExtensionStorage;
  readonly fsm: AttachFsm;
  readonly epoch: number;
  readonly onFrame: (frame: NmFrame) => Promise<void> | void;
  readonly onControlFrame?: (frame: NmControlFrame) => Promise<void> | void;
  readonly onPortReadyChanged?: (ready: boolean) => void;
}): NativeConnection {
  let state: ConnectionState = { kind: "idle" };
  let portReady = false;
  let nextSeq = 0;
  const queuedFrames: NmFrame[] = [];
  // Outbound-side queues: frames the extension produces before host_hello
  // completes installId verification. Flushed by drainQueuedFrames().
  const queuedOutbound: NmFrame[] = [];
  const queuedOutboundControl: NmControlFrame[] = [];

  async function wipeForInstallId(hostInstallId: string): Promise<void> {
    const storedInstallId = await deps.storage.getInstallId();
    if (storedInstallId === hostInstallId) return;
    // Revocation event: installId changed (host reinstall / reprovision).
    // Clear persisted grants AND tear down live debugger sessions via
    // chrome.debugger.detach so Chrome actually ends the attachment — not
    // just forgets local FSM state. handleTabRemoved only cleared local
    // bookkeeping, leaving Chrome debugger sessions live.
    await Promise.all([
      deps.storage.clearAlwaysGrants(),
      deps.storage.clearPrivateOriginAllowlist(),
      deps.storage.clearAllowOnceGrants(),
    ]);
    await deps.fsm.revokeAllAttached();
    await deps.storage.setInstallId(hostInstallId);
  }

  async function sendExtensionHello(
    port: chrome.runtime.Port,
    epoch: number,
    seq: number,
  ): Promise<void> {
    const [instanceId, browserSessionId, extensionName, installId] = await Promise.all([
      deps.storage.getInstanceId(),
      deps.storage.getBrowserSessionId(),
      deps.storage.getExtensionName(),
      deps.storage.getInstallId(),
    ]);
    port.postMessage({
      kind: "extension_hello",
      extensionId: chrome.runtime.id,
      extensionVersion: EXTENSION_VERSION,
      installId,
      browserSessionId,
      supportedProtocols: SUPPORTED_PROTOCOLS,
      identity: {
        instanceId,
        browserSessionId,
        browserHint: detectBrowserHint(),
        name: extensionName,
      },
      epoch,
      seq,
    } satisfies NmControlFrame);
  }

  function drainQueuedFrames(): void {
    if (!portReady) return;
    const frames = queuedFrames.splice(0, queuedFrames.length);
    for (const frame of frames) void deps.onFrame(frame);
    // Also flush any outbound frames that arrived during the handshake.
    if (state.kind === "connected") {
      const port = state.port;
      const outbound = queuedOutbound.splice(0, queuedOutbound.length);
      for (const f of outbound) port.postMessage(f);
      const outboundControl = queuedOutboundControl.splice(0, queuedOutboundControl.length);
      for (const f of outboundControl) port.postMessage(f);
    }
  }

  // On overflow, disconnect the port instead of dropping stateful frames
  // (detach, admin acks, chunks). A silent shift() can leave the host
  // believing a session is still attached or make a chunk reassembly hang.
  // Disconnecting forces a clean reconnect + host_hello cycle; the upstream
  // FSM replays attach state via attach_state_probe after reconnect.
  function disconnectOnOverflow(reason: string): void {
    if (state.kind === "connected") {
      try {
        state.port.disconnect();
      } catch {
        // ignore — port may already be torn down
      }
      state = { kind: "idle" };
      portReady = false;
      deps.onPortReadyChanged?.(false);
    }
    queuedFrames.splice(0, queuedFrames.length);
    queuedOutbound.splice(0, queuedOutbound.length);
    queuedOutboundControl.splice(0, queuedOutboundControl.length);
    // Surface the condition for diagnostics.
    if (globalThis.console?.warn) {
      globalThis.console.warn(`[koi browser-ext] queue overflow (${reason}); forcing reconnect`);
    }
  }

  function postFrame(frame: NmFrame): void {
    if (state.kind !== "connected") return;
    if (!portReady) {
      // Queue outbound frames until host_hello completes installId
      // verification. Sending before that can leak FSM/detach/CDP frames
      // to a host belonging to a DIFFERENT install, violating the
      // reinstall-revocation boundary.
      queuedOutbound.push(frame);
      if (queuedOutbound.length > MAX_QUEUED_FRAMES) {
        disconnectOnOverflow("outbound-queue");
      }
      return;
    }
    state.port.postMessage(frame);
  }

  function postControlFrame(frame: NmControlFrame): void {
    if (state.kind !== "connected") return;
    // Allow `extension_hello` through unconditionally — it is the frame
    // that OPENS the handshake. Every other control frame (ping/pong) is
    // gated on portReady for the same reason as postFrame.
    if (frame.kind !== "extension_hello" && !portReady) {
      queuedOutboundControl.push(frame);
      if (queuedOutboundControl.length > MAX_QUEUED_FRAMES) {
        disconnectOnOverflow("outbound-control-queue");
      }
      return;
    }
    state.port.postMessage(frame);
  }

  async function handlePortMessage(message: unknown): Promise<void> {
    const control = NmControlFrameSchema.safeParse(message);
    if (control.success) {
      if (control.data.kind === "host_hello") {
        portReady = false;
        deps.onPortReadyChanged?.(false);
        await wipeForInstallId(control.data.installId);
        portReady = true;
        deps.onPortReadyChanged?.(true);
        drainQueuedFrames();
      }
      await deps.onControlFrame?.(control.data);
      return;
    }

    const frame = NmFrameSchema.safeParse(message);
    if (!frame.success) return;
    if (!portReady) {
      queuedFrames.push(frame.data);
      if (queuedFrames.length > MAX_QUEUED_FRAMES) {
        // Inbound queue (host→extension pre-host_hello) overflow. Same
        // policy as outbound: force reconnect rather than silently drop
        // stateful frames (admin acks, CDP results, chunk fragments).
        disconnectOnOverflow("inbound-queue");
      }
      return;
    }
    await deps.onFrame(frame.data);
  }

  async function connect(epoch: number, seq: number): Promise<void> {
    const port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((message) => {
      void handlePortMessage(message);
    });
    port.onDisconnect.addListener(() => {
      portReady = false;
      deps.onPortReadyChanged?.(false);
      if (state.kind === "connected" && state.port === port) state = { kind: "idle" };
      void deps.fsm.handleHostDisconnect();
      setTimeout(() => {
        void ensureConnected();
      }, 1_000);
    });
    await sendExtensionHello(port, epoch, seq);
    state = { kind: "connected", epoch, seq, port };
  }

  async function ensureConnected(): Promise<void> {
    if (state.kind === "connected") return;
    if (state.kind === "connecting") {
      await state.promise;
      return;
    }
    const seq = ++nextSeq;
    const promise = connect(deps.epoch, seq);
    state = { kind: "connecting", epoch: deps.epoch, seq, promise };
    try {
      await promise;
    } catch (error) {
      state = { kind: "idle" };
      throw error;
    }
  }

  return {
    ensureConnected,
    postFrame,
    postControlFrame,
    isPortReady: () => portReady,
  };
}
