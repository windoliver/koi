import type { NmControlFrame } from "../../src/native-host/control-frames.js";
import type { NmFrame } from "../../src/native-host/nm-frame.js";
import { respondToAdminClearGrants } from "./admin-responder.js";
import type { AttachFsm } from "./attach-fsm.js";
import { type ChunkSender, createChunkReceiver } from "./chunking.js";
import { respondToAttachStateProbe } from "./probe-responder.js";
import type { ExtensionStorage } from "./storage.js";

export interface Router {
  readonly routeFrame: (frame: NmFrame) => Promise<void>;
  readonly routeControlFrame: (frame: NmControlFrame) => Promise<void>;
}

export function createRouter(deps: {
  readonly fsm: AttachFsm;
  readonly storage: ExtensionStorage;
  readonly emitFrame: (frame: NmFrame) => void;
  readonly chunkSender: ChunkSender;
}): Router {
  const chunkReceiver = createChunkReceiver(async (frame) => {
    await routeFrame(frame);
  });

  async function routeFrame(frame: NmFrame): Promise<void> {
    switch (frame.kind) {
      case "list_tabs": {
        const tabs = (await (
          chrome.tabs.query as unknown as (
            queryInfo: chrome.tabs.QueryInfo,
          ) => Promise<readonly chrome.tabs.Tab[]>
        )({})) as readonly chrome.tabs.Tab[];
        deps.emitFrame({
          kind: "tabs",
          requestId: frame.requestId,
          tabs: tabs
            .filter((tab): tab is chrome.tabs.Tab & { readonly id: number } => tab.id !== undefined)
            .map((tab) => ({
              id: tab.id,
              url: tab.url ?? "",
              title: tab.title ?? "",
            })),
        });
        return;
      }
      case "attach":
        await deps.fsm.handleAttach(frame);
        return;
      case "detach":
        await deps.fsm.handleDetachRequest(frame);
        return;
      case "abandon_attach": {
        const affectedTabs = await deps.fsm.handleAbandonAttach(frame.leaseToken);
        deps.emitFrame({ kind: "abandon_attach_ack", leaseToken: frame.leaseToken, affectedTabs });
        return;
      }
      case "admin_clear_grants":
        await respondToAdminClearGrants({
          storage: deps.storage,
          fsm: deps.fsm,
          request: { scope: frame.scope, origin: frame.origin },
          emitFrame: deps.emitFrame,
        });
        return;
      case "attach_state_probe": {
        const attachedTabs = await respondToAttachStateProbe(deps.fsm);
        deps.emitFrame({
          kind: "attach_state_probe_ack",
          requestId: frame.requestId,
          attachedTabs,
        });
        return;
      }
      case "cdp": {
        const attachedState = deps.fsm.getAttachedStateBySessionId(frame.sessionId);
        if (!attachedState) return;
        try {
          const result = await (
            chrome.debugger.sendCommand as unknown as <TResult = unknown>(
              target: chrome.debugger.Debuggee,
              method: string,
              params?: object,
            ) => Promise<TResult>
          )({ tabId: attachedState.tabId }, frame.method, frame.params as object);
          deps.chunkSender.sendResult({
            kind: "cdp_result",
            sessionId: frame.sessionId,
            id: frame.id,
            result,
          });
        } catch (error) {
          deps.emitFrame({
            kind: "cdp_error",
            sessionId: frame.sessionId,
            id: frame.id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      case "chunk":
        chunkReceiver.addChunk(frame);
        return;
      default:
        return;
    }
  }

  return {
    routeFrame,
    async routeControlFrame(frame): Promise<void> {
      if (frame.kind === "ping") deps.emitFrame({ kind: "pong", seq: frame.seq } as never);
    },
  };
}
