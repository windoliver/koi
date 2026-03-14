/**
 * Node connection handler — manages compute-node lifecycle within the gateway.
 *
 * Handles: handshake → capabilities → registration ack, heartbeat, capacity updates,
 * stale node sweep, reconnect eviction, deregistration on disconnect, and sending frames to nodes.
 */

import type { KoiError, Result } from "@koi/core";
import { notFound } from "@koi/core";
import { swallowError } from "@koi/errors";
import type { AgentStatusEntry, HandshakePayload, NodeFrame } from "./node-handler.js";
import {
  encodeNodeFrame,
  parseNodeFrame,
  validateAgentStatusBatch,
  validateCapabilitiesPayload,
  validateCapacityPayload,
  validateHandshakePayload,
  validateToolsUpdatedPayload,
} from "./node-handler.js";
import type { NodeRegistry, NodeRegistryEvent } from "./node-registry.js";
import type { TransportConnection } from "./transport.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodeConnectionHandler {
  /** Handle the first message identified as a node:handshake. */
  readonly handleFirstMessage: (conn: TransportConnection, data: string) => void;
  /** Handle subsequent messages from a node connection. */
  readonly handleMessage: (conn: TransportConnection, data: string) => void;
  /** Clean up node state for a disconnecting connection. Returns true if it was a node. */
  readonly cleanupNode: (connId: string) => boolean;
  /** Check if a connection belongs to a node. */
  readonly isNodeConnection: (connId: string) => boolean;
  /** Send a NodeFrame to a connected node. */
  readonly sendToNode: (
    nodeId: string,
    frame: NodeFrame,
    connMap: ReadonlyMap<string, TransportConnection>,
  ) => Result<number, KoiError>;
  /** Start periodic sweep for stale nodes. Returns stop function. */
  readonly startNodeSweep: (
    heartbeatThresholdMs: number,
    sweepIntervalMs: number,
    onStale: (nodeId: string, connId: string) => void,
  ) => () => void;
  /** Clear all node state (for gateway stop). */
  readonly clear: () => void;
  /** Look up which nodeId currently hosts a given agentId. */
  readonly lookupAgentNode: (agentId: string) => string | undefined;
  /** Look up all agentIds belonging to a process group. */
  readonly lookupAgentsByGroup: (groupId: string) => readonly string[];
  /** Subscribe to agent status updates (called for every agent:status batch). */
  readonly onAgentStatus: (
    handler: (entry: AgentStatusEntry, nodeId: string) => void,
  ) => () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNodeConnectionHandler(
  registry: NodeRegistry,
  emitNodeEvent: (event: NodeRegistryEvent) => void,
  onEvict: (connId: string) => void,
  onToolFrame?: ((frame: NodeFrame) => void) | undefined,
  onToolsUpdated?: ((nodeId: string) => void) | undefined,
): NodeConnectionHandler {
  const nodeConnMap = new Map<string, string>(); // connId → nodeId
  const connByNode = new Map<string, string>(); // nodeId → connId
  const pendingNodeHandshakes = new Map<
    string,
    { readonly nodeId: string; readonly handshake: HandshakePayload }
  >();

  // Agent index: agentId → nodeId (updated from agent:status frames)
  const agentNodeIndex = new Map<string, string>();
  // Group index: groupId → Set<agentId> (updated from agent:status frames with groupId)
  const groupAgentIndex = new Map<string, Set<string>>();
  // Agent status subscribers
  const agentStatusListeners = new Set<(entry: AgentStatusEntry, nodeId: string) => void>();

  function updateAgentIndex(entry: AgentStatusEntry, nodeId: string): void {
    if (entry.state === "terminated") {
      // Remove from indices on termination
      const prevNode = agentNodeIndex.get(entry.agentId);
      if (prevNode !== undefined) {
        agentNodeIndex.delete(entry.agentId);
      }
      if (entry.groupId !== undefined) {
        const group = groupAgentIndex.get(entry.groupId);
        if (group !== undefined) {
          group.delete(entry.agentId);
          if (group.size === 0) groupAgentIndex.delete(entry.groupId);
        }
      }
    } else {
      agentNodeIndex.set(entry.agentId, nodeId);
      if (entry.groupId !== undefined) {
        let group = groupAgentIndex.get(entry.groupId);
        if (group === undefined) {
          group = new Set();
          groupAgentIndex.set(entry.groupId, group);
        }
        group.add(entry.agentId);
      }
    }
    // Notify subscribers — isolate errors so one failing handler doesn't break others
    for (const handler of agentStatusListeners) {
      try {
        handler(entry, nodeId);
      } catch (_handlerError: unknown) {
        // Handlers are responsible for their own error handling.
      }
    }
  }

  function handleFirstMessage(conn: TransportConnection, data: string): void {
    const parseResult = parseNodeFrame(data);
    if (!parseResult.ok) {
      conn.close(4002, parseResult.error.message);
      return;
    }

    const frame = parseResult.value;
    if (frame.kind !== "node:handshake") {
      conn.close(4002, `Expected node:handshake, got ${frame.kind}`);
      return;
    }

    if (frame.nodeId.length === 0) {
      conn.close(4002, "nodeId must not be empty");
      return;
    }

    // Evict stale connection if same nodeId reconnects
    const existingConnId = connByNode.get(frame.nodeId);
    if (existingConnId !== undefined) {
      cleanupNode(existingConnId);
      onEvict(existingConnId);
    }

    const payloadResult = validateHandshakePayload(frame.payload);
    if (!payloadResult.ok) {
      conn.close(4002, payloadResult.error.message);
      return;
    }

    // Mark connection as a node connection
    nodeConnMap.set(conn.id, frame.nodeId);
    connByNode.set(frame.nodeId, conn.id);
    pendingNodeHandshakes.set(conn.id, {
      nodeId: frame.nodeId,
      handshake: payloadResult.value,
    });
  }

  function handleMessage(conn: TransportConnection, data: string): void {
    const parseResult = parseNodeFrame(data);
    if (!parseResult.ok) {
      conn.close(4002, parseResult.error.message);
      cleanupNode(conn.id);
      return;
    }

    const frame = parseResult.value;

    switch (frame.kind) {
      case "node:capabilities": {
        const pending = pendingNodeHandshakes.get(conn.id);
        if (pending === undefined) {
          conn.close(4002, "Received capabilities without prior handshake");
          cleanupNode(conn.id);
          return;
        }
        pendingNodeHandshakes.delete(conn.id);

        const capsResult = validateCapabilitiesPayload(frame.payload);
        if (!capsResult.ok) {
          conn.close(4002, capsResult.error.message);
          cleanupNode(conn.id);
          return;
        }

        const now = Date.now();
        const regResult = registry.register({
          nodeId: pending.nodeId,
          mode: capsResult.value.nodeType,
          tools: capsResult.value.tools,
          capacity: pending.handshake.capacity,
          connectedAt: now,
          lastHeartbeat: now,
          connId: conn.id,
        });

        if (!regResult.ok) {
          conn.close(4002, regResult.error.message);
          cleanupNode(conn.id);
          return;
        }

        const node = registry.lookup(pending.nodeId);
        if (node !== undefined) {
          emitNodeEvent({ kind: "registered", node });
        }

        // Send registration ack back to the node
        const ackFrame: NodeFrame = {
          kind: "node:registered",
          nodeId: pending.nodeId,
          agentId: "",
          correlationId: frame.correlationId,
          payload: { registeredAt: now },
        };
        conn.send(encodeNodeFrame(ackFrame));
        return;
      }

      case "node:heartbeat": {
        const nodeId = nodeConnMap.get(conn.id);
        if (nodeId !== undefined) {
          registry.updateHeartbeat(nodeId);
          emitNodeEvent({ kind: "heartbeat", nodeId });
        }
        return;
      }

      case "node:capacity": {
        const nodeId = nodeConnMap.get(conn.id);
        if (nodeId !== undefined) {
          const capResult = validateCapacityPayload(frame.payload);
          if (!capResult.ok) {
            swallowError(capResult.error, { package: "gateway", operation: "node:capacity" });
            return;
          }
          registry.updateCapacity(nodeId, capResult.value);
          emitNodeEvent({
            kind: "capacity_updated",
            nodeId,
            capacity: capResult.value,
          });
        }
        return;
      }

      case "node:tools_updated": {
        const nodeId = nodeConnMap.get(conn.id);
        if (nodeId === undefined) {
          conn.close(4002, "Received tools_updated before registration");
          cleanupNode(conn.id);
          return;
        }

        // Reject if node is still in pending handshake state (not yet registered)
        if (pendingNodeHandshakes.has(conn.id)) {
          conn.close(4002, "Received tools_updated before registration");
          cleanupNode(conn.id);
          return;
        }

        const tuResult = validateToolsUpdatedPayload(frame.payload);
        if (!tuResult.ok) {
          swallowError(tuResult.error, { package: "gateway", operation: "node:tools_updated" });
          return;
        }

        const { added, removed } = tuResult.value;
        const updateResult = registry.updateTools(nodeId, added, removed);
        if (!updateResult.ok) {
          swallowError(updateResult.error, { package: "gateway", operation: "node:tools_updated" });
          return;
        }

        if (added.length > 0) {
          emitNodeEvent({ kind: "tools_added", nodeId, tools: added });
        }
        if (removed.length > 0) {
          emitNodeEvent({ kind: "tools_removed", nodeId, toolNames: removed });
        }

        // Notify tool router so queued calls can be dequeued
        if (added.length > 0) {
          onToolsUpdated?.(nodeId);
        }
        return;
      }

      case "agent:status": {
        const nodeId = nodeConnMap.get(conn.id);
        if (nodeId === undefined) return;
        const batch = validateAgentStatusBatch(frame.payload);
        if (batch === undefined) return;
        for (const entry of batch.agents) {
          updateAgentIndex(entry, nodeId);
        }
        return;
      }

      case "tool_call":
      case "tool_result":
      case "tool_error": {
        onToolFrame?.(frame);
        return;
      }

      default:
        return;
    }
  }

  function cleanupNode(connId: string): boolean {
    const nodeId = nodeConnMap.get(connId);
    if (nodeId === undefined) return false;

    nodeConnMap.delete(connId);
    connByNode.delete(nodeId);
    pendingNodeHandshakes.delete(connId);

    // Purge agent indices for the disconnected node
    for (const [agentId, ownerNodeId] of agentNodeIndex) {
      if (ownerNodeId === nodeId) {
        agentNodeIndex.delete(agentId);
      }
    }
    for (const [groupId, group] of groupAgentIndex) {
      for (const agentId of group) {
        if (agentNodeIndex.get(agentId) === undefined) {
          group.delete(agentId);
        }
      }
      if (group.size === 0) groupAgentIndex.delete(groupId);
    }

    const deregResult = registry.deregister(nodeId);
    if (deregResult.ok && deregResult.value) {
      emitNodeEvent({ kind: "deregistered", nodeId });
    }
    return true;
  }

  return {
    handleFirstMessage,
    handleMessage,
    cleanupNode,

    isNodeConnection(connId: string): boolean {
      return nodeConnMap.has(connId);
    },

    sendToNode(
      nodeId: string,
      frame: NodeFrame,
      connMap: ReadonlyMap<string, TransportConnection>,
    ): Result<number, KoiError> {
      const connId = connByNode.get(nodeId);
      if (connId === undefined) {
        return { ok: false, error: notFound(nodeId, `Node not connected: ${nodeId}`) };
      }

      const conn = connMap.get(connId);
      if (conn === undefined) {
        return { ok: false, error: notFound(nodeId, `Connection not found for node: ${nodeId}`) };
      }

      const encoded = encodeNodeFrame(frame);
      const sendResult = conn.send(encoded);

      if (sendResult === 0) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: "Send dropped (connection closed)",
            retryable: false,
          },
        };
      }

      return { ok: true, value: sendResult };
    },

    startNodeSweep(
      heartbeatThresholdMs: number,
      sweepIntervalMs: number,
      onStale: (nodeId: string, connId: string) => void,
    ): () => void {
      const timer = setInterval(() => {
        const now = Date.now();
        for (const [nodeId, node] of registry.nodes()) {
          if (now - node.lastHeartbeat >= heartbeatThresholdMs) {
            onStale(nodeId, node.connId);
          }
        }
      }, sweepIntervalMs);
      return () => clearInterval(timer);
    },

    clear(): void {
      nodeConnMap.clear();
      connByNode.clear();
      pendingNodeHandshakes.clear();
      agentNodeIndex.clear();
      groupAgentIndex.clear();
      agentStatusListeners.clear();
    },

    lookupAgentNode(agentId: string): string | undefined {
      return agentNodeIndex.get(agentId);
    },

    lookupAgentsByGroup(groupId: string): readonly string[] {
      const group = groupAgentIndex.get(groupId);
      return group !== undefined ? [...group] : [];
    },

    onAgentStatus(handler: (entry: AgentStatusEntry, nodeId: string) => void): () => void {
      agentStatusListeners.add(handler);
      let removed = false; // let: set to true on first unsubscribe (idempotent guard)
      return () => {
        if (removed) return;
        removed = true;
        agentStatusListeners.delete(handler);
      };
    },
  };
}
