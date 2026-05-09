import type { AgentNamespace, GroupNamespace } from "./types.js";

export function computeAgentNamespace(agentId: string): AgentNamespace {
  const base = `agents/${agentId}`;
  return {
    filesystem: `${base}/filesystem`,
    mailbox: `${base}/mailbox`,
    snapshotStore: `${base}/snapshots`,
    playbooks: `${base}/playbooks`,
    handoffs: `${base}/handoffs`,
  };
}

export function computeGroupNamespace(groupId: string): GroupNamespace {
  return {
    scratchpad: `groups/${groupId}/scratchpad`,
  };
}
