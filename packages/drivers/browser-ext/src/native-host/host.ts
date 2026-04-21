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
  // Placeholder — overwritten with extension-supplied instanceId before
  // any identity-bound state (quarantine journal, discovery record) is
  // created. Using a fresh UUID would break restart-stable grouping.
  let instanceId = config.instanceId ?? "";
  const expectedToken = await readToken(config.authDir);
  // Fail-closed: if admin.key is missing/unreadable, `expectedAdminKey`
  // stays null and validateHello rejects any hello that claims admin role.
  // A missing secret MUST NOT degrade to the empty string — a client that
  // knows the regular driver token could otherwise escalate to admin by
  // sending an empty admin key.
  const expectedAdminKey: string | null = await readAdminKey(config.authDir).catch(() => null);
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
  const driverLeases = new Map<string, string>();
  const leasesInUse = new Set<string>();
  /**
   * Per-request routing maps. Required for tenant isolation: without these,
   * any connected client would see every other client's tabs + CDP traffic.
   */
  // Map host-generated requestId → { clientId, originalRequestId }.
  // We MUST NOT key routing on the driver-supplied requestId: one authenticated
  // client can intentionally (or accidentally) reuse another's requestId and
  // steal its `tabs` reply. Host rewrites the outgoing requestId before sending
  // to the extension, and rewrites the reply back to the original id for the
  // waiting client.
  const pendingListTabs = new Map<
    string,
    { readonly clientId: string; readonly originalRequestId: string }
  >();
  // Same host-generated-requestId routing for open_tab / close_tab, for the
  // same cross-client-steal reason documented on pendingListTabs.
  const pendingTabOps = new Map<
    string,
    {
      readonly clientId: string;
      readonly originalRequestId: string;
      readonly kind: "open_tab" | "close_tab";
    }
  >();
  const pendingCdpRequests = new Map<string, string>(); // `${sessionId}:${id}` → clientId
  const cdpKey = (sessionId: string, id: number): string => `${sessionId}:${id}`;

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
        // Chunks reassemble into one of cdp_result / cdp_error / cdp_event.
        // Route through the same handler as the non-chunked path for
        // per-request tenant isolation.
        if (frame.kind === "cdp_result" || frame.kind === "cdp_error") {
          const requester = pendingCdpRequests.get(cdpKey(frame.sessionId, frame.id));
          if (requester) {
            pendingCdpRequests.delete(cdpKey(frame.sessionId, frame.id));
            drivers.get(requester)?.send(frame as DriverFrame);
          }
          return;
        }
        if (frame.kind === "cdp_event") {
          for (const [, owner] of ownership.entries()) {
            if (owner.phase === "committed" && owner.sessionId === frame.sessionId) {
              drivers.get(owner.clientId)?.send(frame as DriverFrame);
              return;
            }
          }
        }
      },
      onTimeout: () => {},
      onGroupDrop: () => {},
    },
  });

  const pendingProbes = new Map<
    string,
    (v: { readonly attachedTabs: readonly number[] } | null) => void
  >();
  // Per-requestId admin waiters so a late ack from a prior (timed-out) request
  // can't satisfy a new retry's resolver with stale data. Keyed by the host-
  // generated requestId round-tripped through the extension.
  const pendingAdminResolvers = new Map<
    string,
    (
      v: {
        readonly clearedOrigins: readonly string[];
        readonly detachedTabs: readonly number[];
      } | null,
    ) => void
  >();

  let extensionVersion: string | null = null;
  let selectedProtocol = 1;
  let extensionBrowserSessionId: string | null = null;
  let extensionIdentity: {
    readonly instanceId: string;
    readonly browserSessionId: string;
    readonly epoch: number;
    readonly seq: number;
  } | null = null;
  let resolveExtensionHello:
    | ((value: {
        readonly browserSessionId: string;
        readonly instanceId: string;
        readonly epoch: number;
        readonly seq: number;
      }) => void)
    | null = null;
  const extensionHelloReceived = new Promise<{
    readonly browserSessionId: string;
    readonly instanceId: string;
    readonly epoch: number;
    readonly seq: number;
  }>((resolve) => {
    resolveExtensionHello = resolve;
  });
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
      extensionBrowserSessionId = frame.browserSessionId;
      const negotiated = negotiateProtocol(
        [...frame.supportedProtocols],
        [...HOST_SUPPORTED_PROTOCOLS],
      );
      if (!negotiated.ok) {
        // Fail-closed: no shared protocol version. The NM control frame
        // schema doesn't encode a failure mode for host_hello, so signal
        // version skew by closing the port — the extension watchdog detects
        // the disconnect and surfaces it to the user.
        console.error(
          `[browser-ext] protocol negotiation failed: extension supports ${JSON.stringify(
            frame.supportedProtocols,
          )}, host supports ${JSON.stringify(HOST_SUPPORTED_PROTOCOLS)}`,
        );
        done();
        return;
      }
      selectedProtocol = negotiated.selectedProtocol;
      // Bind host state to the extension's persisted identity + ordering
      // metadata when present. Using a fresh UUID would break restart-stable
      // grouping: quarantine + discovery records would spawn under new
      // names after each host restart, and discovery-client could no
      // longer supersede older generations within the same extension.
      // Fall back to config.instanceId/config.epoch + seq=1 only when the
      // extension doesn't supply these (legacy tests, older extensions).
      const extInstanceId = frame.identity?.instanceId;
      const extEpoch = frame.epoch;
      const extSeq = frame.seq;
      instanceId =
        extInstanceId ?? (instanceId === "" ? (config.instanceId ?? randomUUID()) : instanceId);
      extensionIdentity = {
        instanceId,
        browserSessionId: frame.browserSessionId,
        epoch: extEpoch ?? config.epoch,
        seq: extSeq ?? 1,
      };
      sendNmControl({
        kind: "host_hello",
        hostVersion: HOST_VERSION,
        installId,
        selectedProtocol,
      });
      if (resolveExtensionHello) {
        resolveExtensionHello({
          browserSessionId: frame.browserSessionId,
          instanceId,
          epoch: extEpoch ?? config.epoch,
          seq: extSeq ?? 1,
        });
        resolveExtensionHello = null;
      }
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
        const resolver = pendingAdminResolvers.get(frame.requestId);
        if (resolver === undefined) {
          // Unknown / stale requestId — drop silently. The waiter already
          // timed out; satisfying a different retry's resolver here would
          // misreport stale clearedOrigins/detachedTabs.
          return;
        }
        pendingAdminResolvers.delete(frame.requestId);
        resolver({
          clearedOrigins: frame.clearedOrigins,
          detachedTabs: frame.detachedTabs,
        });
        return;
      }
      case "chunk":
        chunkBuffer.add(frame);
        return;
      case "cdp_result":
      case "cdp_error": {
        const requester = pendingCdpRequests.get(cdpKey(frame.sessionId, frame.id));
        if (requester) {
          pendingCdpRequests.delete(cdpKey(frame.sessionId, frame.id));
          drivers.get(requester)?.send(frame as DriverFrame);
        }
        return;
      }
      case "cdp_event": {
        // Route events to the session owner (ownership map tracks tabId →
        // clientId). This avoids cross-tenant leakage of CDP event traffic.
        for (const [, owner] of ownership.entries()) {
          if (owner.phase === "committed" && owner.sessionId === frame.sessionId) {
            drivers.get(owner.clientId)?.send(frame as DriverFrame);
            return;
          }
        }
        return;
      }
      case "tabs": {
        const pending = pendingListTabs.get(frame.requestId);
        if (pending !== undefined) {
          pendingListTabs.delete(frame.requestId);
          // Rewrite the reply's requestId back to the original so the driver
          // can correlate with its outstanding request.
          drivers.get(pending.clientId)?.send({
            ...frame,
            requestId: pending.originalRequestId,
          } as DriverFrame);
        }
        return;
      }
      case "abandon_attach_ack":
        // NM-only: the extension acknowledges the host's abandon_attach. This
        // is an internal host/extension handshake — not forwarded to drivers.
        return;
      case "tab_opened":
      case "tab_closed": {
        const pending = pendingTabOps.get(frame.requestId);
        if (pending !== undefined) {
          pendingTabOps.delete(frame.requestId);
          drivers.get(pending.clientId)?.send({
            ...frame,
            requestId: pending.originalRequestId,
          } as DriverFrame);
        }
        return;
      }
      default:
        return;
    }
  }

  const helloTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("extension_hello not received within 10s")), 10_000),
  );
  const helloInfo = await Promise.race([extensionHelloReceived, helloTimeout]);
  void extensionBrowserSessionId;
  const quarantineJournal = await createQuarantineJournal({
    dir: config.quarantineDir,
    instanceId, // extension-supplied via helloInfo.instanceId
    browserSessionId: helloInfo.browserSessionId,
  });

  const probeResult = await runBootProbe({
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
  if (!probeResult.ok) {
    throw new Error(
      `Browser-ext host: boot probe failed (${probeResult.error ?? "unknown"}); refusing to publish discovery`,
    );
  }

  const server = await createSocketServer({
    socketPath: config.socketPath,
    onConnection: (socket) => {
      const clientId = randomUUID();
      const driverWriter = createFrameWriter(socket);
      drivers.set(clientId, {
        send: (frame) => void driverWriter.write(JSON.stringify(frame)),
        close: () => socket.destroy(),
      });
      // Unauthenticated handshake deadline: reap sockets that never complete
      // `hello` within the window. Without this, a local process can open
      // many connections and stall them pre-auth to exhaust fds/memory.
      const HANDSHAKE_DEADLINE_MS = 5_000;
      const handshakeTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (!driverLeases.has(clientId)) {
          drivers.get(clientId)?.close();
        }
      }, HANDSHAKE_DEADLINE_MS);
      if (typeof handshakeTimer.unref === "function") handshakeTimer.unref();
      socket.once("close", () => clearTimeout(handshakeTimer));
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
          const lease = driverLeases.get(clientId);
          if (lease !== undefined) {
            leasesInUse.delete(lease);
            driverLeases.delete(clientId);
          }
          // Clear any pending routing state owned by this client.
          for (const [hostReqId, pending] of pendingListTabs) {
            if (pending.clientId === clientId) pendingListTabs.delete(hostReqId);
          }
          for (const [hostReqId, pending] of pendingTabOps) {
            if (pending.clientId === clientId) pendingTabOps.delete(hostReqId);
          }
          for (const [k, c] of pendingCdpRequests) {
            if (c === clientId) pendingCdpRequests.delete(k);
          }
          attach.handleDriverDisconnect(clientId);
        }
      })();
    },
  });

  function handleDriverFrame(clientId: string, frame: DriverFrame): void {
    // Auth gate: reject every frame except `hello` until the driver has
    // successfully completed the token/lease handshake. Without this, an
    // unauthenticated client could enumerate tabs via `list_tabs` or send
    // CDP traffic without ever presenting the shared token.
    if (frame.kind !== "hello" && !driverLeases.has(clientId)) {
      drivers.get(clientId)?.close();
      return;
    }
    switch (frame.kind) {
      case "hello": {
        // Close the socket after any negative hello_ack so a misbehaving
        // client cannot park a stream of failed-auth sockets on the host.
        const rejectAndClose = (reason: string, extras?: Record<string, unknown>): void => {
          drivers
            .get(clientId)
            ?.send({ kind: "hello_ack", ok: false, reason, ...(extras ?? {}) } as DriverFrame);
          drivers.get(clientId)?.close();
        };
        if (driverLeases.has(clientId)) {
          rejectAndClose("bad_lease_token");
          return;
        }
        if (leasesInUse.has(frame.leaseToken)) {
          rejectAndClose("lease_collision");
          return;
        }
        // Validate the driver's advertised supportedProtocols against the
        // host's selected protocol (already negotiated with the extension).
        if (!frame.supportedProtocols.includes(selectedProtocol)) {
          rejectAndClose("version_mismatch", { hostSupportedProtocols: [selectedProtocol] });
          return;
        }
        const validation = validateHello(
          { token: frame.token, admin: frame.admin },
          { token: expectedToken, adminKey: expectedAdminKey },
        );
        if (!validation.ok) {
          rejectAndClose(validation.reason);
          return;
        }
        driverRoles.set(clientId, validation.role);
        driverLeases.set(clientId, frame.leaseToken);
        leasesInUse.add(frame.leaseToken);
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
      case "list_tabs": {
        const hostRequestId = randomUUID();
        pendingListTabs.set(hostRequestId, {
          clientId,
          originalRequestId: frame.requestId,
        });
        sendNm({ ...frame, requestId: hostRequestId });
        return;
      }
      case "open_tab": {
        const hostRequestId = randomUUID();
        pendingTabOps.set(hostRequestId, {
          clientId,
          originalRequestId: frame.requestId,
          kind: "open_tab",
        });
        sendNm({ ...frame, requestId: hostRequestId });
        return;
      }
      case "close_tab": {
        const hostRequestId = randomUUID();
        pendingTabOps.set(hostRequestId, {
          clientId,
          originalRequestId: frame.requestId,
          kind: "close_tab",
        });
        sendNm({ ...frame, requestId: hostRequestId });
        return;
      }
      case "attach": {
        const pinnedLease = driverLeases.get(clientId);
        if (pinnedLease === undefined || pinnedLease !== frame.leaseToken) {
          drivers.get(clientId)?.send({
            kind: "attach_ack",
            ok: false,
            tabId: frame.tabId,
            leaseToken: frame.leaseToken,
            attachRequestId: frame.attachRequestId,
            reason: "no_permission",
          });
          return;
        }
        attach.handleAttachFromDriver(clientId, frame);
        return;
      }
      case "detach": {
        const tab = findTabByOwner(clientId, frame.sessionId);
        if (tab === undefined) {
          drivers.get(clientId)?.send({
            kind: "detach_ack",
            sessionId: frame.sessionId,
            ok: false,
            reason: "not_attached",
          });
          return;
        }
        detach.initiateHostDetach(tab);
        return;
      }
      case "cdp": {
        // Ownership check: only the client that currently owns the session's
        // tab can send CDP frames for it. Without this gate, a second
        // authenticated client that learned or guessed a sessionId could
        // drive another client's attached tab — a tenant-isolation break.
        const tab = findTabByOwner(clientId, frame.sessionId);
        if (tab === undefined) {
          drivers.get(clientId)?.send({
            kind: "cdp_error",
            sessionId: frame.sessionId,
            id: frame.id,
            error: { code: -32000, message: "not attached" },
          });
          return;
        }
        pendingCdpRequests.set(cdpKey(frame.sessionId, frame.id), clientId);
        sendNm(frame);
        return;
      }
      case "admin_clear_grants": {
        // Reject malformed requests up-front so operator mistakes
        // ({ scope: "origin" } without `origin`) don't quietly succeed
        // with an empty cleared-origins ack.
        if (frame.scope === "origin" && (!frame.origin || frame.origin.length === 0)) {
          drivers.get(clientId)?.send({
            kind: "admin_clear_grants_ack",
            ok: false,
            reason: "PERMISSION",
          });
          return;
        }
        const adminRequestId = randomUUID();
        void handleAdminClearGrants({
          role: driverRoles.get(clientId) ?? "driver",
          scope: frame.scope,
          origin: frame.origin,
          requestId: adminRequestId,
          sendNm,
          awaitAck: (requestId, timeoutMs) =>
            new Promise((resolve) => {
              pendingAdminResolvers.set(requestId, resolve);
              setTimeout(() => {
                // Only fire null if our waiter is still registered. A late
                // ack that arrived just before the timer fires will have
                // already resolved and removed the entry.
                if (pendingAdminResolvers.get(requestId) === resolve) {
                  pendingAdminResolvers.delete(requestId);
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
      }
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

  // Discovery ordering must reflect the extension's persisted (epoch, seq).
  // discovery-client selects the highest (epoch, seq) within an instanceId
  // group; a fresh host boot that keeps config.epoch + seq=1 would publish
  // the same or lower apparent generation than an existing record, making
  // supersede nondeterministic after repeated reconnects.
  const discoveryRecord: DiscoveryRecord = {
    instanceId,
    pid: process.pid,
    socket: config.socketPath,
    ready: true,
    name: config.name,
    browserHint: config.browserHint,
    extensionVersion,
    epoch: helloInfo.epoch,
    seq: helloInfo.seq,
  };
  void extensionIdentity;
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
