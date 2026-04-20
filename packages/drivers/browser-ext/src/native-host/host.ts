import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { handleAdminClearGrants } from "./admin-flow.js";
import { createAttachCoordinator } from "./attach-flow.js";
import { readAdminKey, readToken, validateHello } from "./auth.js";
import { createChunkBuffer } from "./chunk-reassembly.js";
import {
  createWatchdog,
  type NmControlFrame,
  NmControlFrameSchema,
  negotiateProtocol,
} from "./control-frames.js";
import { createDetachCoordinator } from "./detach-flow.js";
import {
  type DiscoveryRecord,
  supersedeStale,
  unlinkDiscoveryFile,
  writeDiscoveryFile,
} from "./discovery.js";
import { type DriverFrame, DriverFrameSchema, isDriverOriginated } from "./driver-frame.js";
import { createFrameReader } from "./frame-reader.js";
import { createFrameWriter } from "./frame-writer.js";
import { createInFlightMap } from "./in-flight-map.js";
import { readInstallId } from "./install-id.js";
import { isExtensionOriginated, type NmFrame, NmFrameSchema } from "./nm-frame.js";
import { createOwnershipMap } from "./ownership-map.js";
import { runBootProbe } from "./probe.js";
import { createQuarantineJournal } from "./quarantine-journal.js";
import { createSocketServer } from "./socket-server.js";

export const HOST_SUPPORTED_PROTOCOLS = [1] as const;
export const HOST_VERSION = "0.1.0";

export interface NativeHostConfig {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly socketPath: string;
  readonly discoveryDir: string;
  readonly quarantineDir: string;
  readonly authDir: string;
  readonly instanceId?: string;
  readonly name: string;
  readonly browserHint: string | null;
  readonly epoch: number;
}

export interface NativeHostHandle {
  readonly waitUntilDone: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

export async function runNativeHost(config: NativeHostConfig): Promise<NativeHostHandle> {
  const instanceId = config.instanceId ?? randomUUID();
  const expectedToken = await readToken(config.authDir);
  const expectedAdminKey = await readAdminKey(config.authDir).catch(() => "");
  const installId = await readInstallId(config.authDir);

  const writer = createFrameWriter(config.stdout);
  const sendNm = (frame: NmFrame): void => {
    void writer.write(JSON.stringify(frame));
  };
  const sendNmControl = (frame: Record<string, unknown>): void => {
    void writer.write(JSON.stringify(frame));
  };

  const ownership = createOwnershipMap();
  const inFlight = createInFlightMap();
  const drivers = new Map<string, { send: (frame: DriverFrame) => void; close: () => void }>();
  const driverRoles = new Map<string, "driver" | "admin">();

  const detach = createDetachCoordinator({
    ownership,
    sendNm,
    notifyDriver: (clientId, frame) => {
      const driver = drivers.get(clientId);
      if (!driver) return;
      driver.send(frame as DriverFrame);
    },
    now: () => Date.now(),
  });

  const attach = createAttachCoordinator({
    ownership,
    inFlight,
    sendNm,
    sendDriver: (clientId, frame) => drivers.get(clientId)?.send(frame),
    initiateHostDetach: (tabId) => detach.initiateHostDetach(tabId),
    now: () => Date.now(),
  });

  const chunkBuffer = createChunkBuffer({
    events: {
      onFrameReady: (frame) => {
        for (const driver of drivers.values()) driver.send(frame as DriverFrame);
      },
      onTimeout: () => {},
      onGroupDrop: () => {},
    },
  });

  const pendingProbes = new Map<
    string,
    (v: { readonly attachedTabs: readonly number[] } | null) => void
  >();
  let pendingAdminResolve:
    | ((
        v: {
          readonly clearedOrigins: readonly string[];
          readonly detachedTabs: readonly number[];
        } | null,
      ) => void)
    | undefined;

  let extensionVersion: string | null = null;
  let selectedProtocol = 1;
  let done: () => void = () => {};
  const completion = new Promise<void>((r) => {
    done = r;
  });

  const reader = createFrameReader(config.stdin);
  (async function pump(): Promise<void> {
    try {
      for await (const raw of reader) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const control = NmControlFrameSchema.safeParse(parsed);
        if (control.success) {
          handleControl(control.data);
          continue;
        }
        const nm = NmFrameSchema.safeParse(parsed);
        if (!nm.success) continue;
        if (!isExtensionOriginated(nm.data)) continue;
        handleNm(nm.data);
      }
    } finally {
      done();
    }
  })();

  function handleControl(frame: NmControlFrame): void {
    if (frame.kind === "ping") {
      sendNmControl({ kind: "pong", seq: frame.seq });
      return;
    }
    if (frame.kind === "pong") {
      watchdog.onPong(frame.seq);
      return;
    }
    if (frame.kind === "extension_hello") {
      extensionVersion = frame.extensionVersion;
      const negotiated = negotiateProtocol(
        [...frame.supportedProtocols],
        [...HOST_SUPPORTED_PROTOCOLS],
      );
      if (negotiated.ok) {
        selectedProtocol = negotiated.selectedProtocol;
      }
      sendNmControl({
        kind: "host_hello",
        hostVersion: HOST_VERSION,
        installId,
        selectedProtocol,
      });
    }
  }

  const watchdog = createWatchdog({
    intervalMs: 5_000,
    maxMisses: 3,
    send: (f) => sendNmControl(f),
    onExpire: () => {
      done();
    },
  });

  function handleNm(frame: NmFrame): void {
    switch (frame.kind) {
      case "attach_ack":
        attach.handleAttachAckFromExtension(frame);
        return;
      case "detach_ack":
        detach.handleDetachAck(frame);
        return;
      case "detached":
        detach.handleDetachedFromExtension(frame);
        return;
      case "attach_state_probe_ack": {
        const resolver = pendingProbes.get(frame.requestId);
        if (resolver) {
          pendingProbes.delete(frame.requestId);
          resolver({ attachedTabs: frame.attachedTabs });
        }
        return;
      }
      case "admin_clear_grants_ack": {
        pendingAdminResolve?.({
          clearedOrigins: frame.clearedOrigins,
          detachedTabs: frame.detachedTabs,
        });
        pendingAdminResolve = undefined;
        return;
      }
      case "chunk":
        chunkBuffer.add(frame);
        return;
      case "cdp_result":
      case "cdp_error":
      case "cdp_event":
      case "tabs":
      case "abandon_attach_ack": {
        for (const driver of drivers.values()) driver.send(frame as DriverFrame);
        return;
      }
      default:
        return;
    }
  }

  const browserSessionId = `sess-${instanceId}`;
  const quarantineJournal = await createQuarantineJournal({
    dir: config.quarantineDir,
    instanceId,
    browserSessionId,
  });

  await runBootProbe({
    sendNm,
    awaitAck: (requestId, timeoutMs) =>
      new Promise((resolve) => {
        pendingProbes.set(requestId, resolve);
        setTimeout(() => {
          if (pendingProbes.delete(requestId)) resolve(null);
        }, timeoutMs);
      }),
    ownership,
    quarantineJournal,
    writerEpoch: config.epoch,
    writerSeq: 1,
    now: () => Date.now(),
  });

  const server = await createSocketServer({
    socketPath: config.socketPath,
    onConnection: (socket) => {
      const clientId = randomUUID();
      const driverWriter = createFrameWriter(socket);
      drivers.set(clientId, {
        send: (frame) => void driverWriter.write(JSON.stringify(frame)),
        close: () => socket.destroy(),
      });
      (async (): Promise<void> => {
        try {
          for await (const raw of createFrameReader(socket)) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              continue;
            }
            const f = DriverFrameSchema.safeParse(parsed);
            if (!f.success) continue;
            if (!isDriverOriginated(f.data)) continue;
            handleDriverFrame(clientId, f.data);
          }
        } finally {
          drivers.delete(clientId);
          driverRoles.delete(clientId);
          attach.handleDriverDisconnect(clientId);
        }
      })();
    },
  });

  function handleDriverFrame(clientId: string, frame: DriverFrame): void {
    switch (frame.kind) {
      case "hello": {
        const validation = validateHello(
          { token: frame.token, admin: frame.admin },
          { token: expectedToken, adminKey: expectedAdminKey },
        );
        if (!validation.ok) {
          drivers.get(clientId)?.send({ kind: "hello_ack", ok: false, reason: validation.reason });
          return;
        }
        driverRoles.set(clientId, validation.role);
        drivers.get(clientId)?.send({
          kind: "hello_ack",
          ok: true,
          role: validation.role,
          hostVersion: HOST_VERSION,
          extensionVersion,
          wsEndpoint: "",
          selectedProtocol,
        });
        return;
      }
      case "list_tabs":
        sendNm(frame);
        return;
      case "attach":
        attach.handleAttachFromDriver(clientId, frame);
        return;
      case "detach":
        detach.initiateHostDetach(findTabByOwner(clientId, frame.sessionId) ?? -1);
        return;
      case "cdp":
        sendNm(frame);
        return;
      case "admin_clear_grants":
        void handleAdminClearGrants({
          role: driverRoles.get(clientId) ?? "driver",
          scope: frame.scope,
          origin: frame.origin,
          sendNm,
          awaitAck: (timeoutMs) =>
            new Promise((resolve) => {
              pendingAdminResolve = resolve;
              setTimeout(() => {
                if (pendingAdminResolve === resolve) {
                  pendingAdminResolve = undefined;
                  resolve(null);
                }
              }, timeoutMs);
            }),
        }).then((result) => {
          if (result.ok) {
            drivers.get(clientId)?.send({
              kind: "admin_clear_grants_ack",
              ok: true,
              clearedOrigins: result.clearedOrigins ?? [],
              detachedTabs: result.detachedTabs ?? [],
            });
            return;
          }

          drivers.get(clientId)?.send({
            kind: "admin_clear_grants_ack",
            ok: false,
            reason: result.error ?? "timeout",
          });
        });
        return;
      case "bye":
        drivers.get(clientId)?.close();
        return;
      default:
        return;
    }
  }

  function findTabByOwner(clientId: string, sessionId: string): number | undefined {
    for (const [tabId, owner] of ownership.entries()) {
      if (owner.clientId === clientId && owner.sessionId === sessionId) return tabId;
    }
    return undefined;
  }

  const discoveryRecord: DiscoveryRecord = {
    instanceId,
    pid: process.pid,
    socket: config.socketPath,
    ready: true,
    name: config.name,
    browserHint: config.browserHint,
    extensionVersion,
    epoch: config.epoch,
    seq: 1,
  };
  await supersedeStale(config.discoveryDir, discoveryRecord);
  await writeDiscoveryFile(config.discoveryDir, discoveryRecord);

  watchdog.start();

  return {
    waitUntilDone: () => completion,
    shutdown: async (): Promise<void> => {
      watchdog.stop();
      detach.clearAll();
      await server.close();
      await unlinkDiscoveryFile(config.discoveryDir, process.pid);
      done();

      // Suppress intentional unused binding for admin handler reference.
      void handleAdminClearGrants;
    },
  };
}
