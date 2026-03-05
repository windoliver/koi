/**
 * Node stack types — config and return types for the full node bundle.
 */

import type { DiscoveryProviderConfig } from "@koi/agent-discovery";
import type { ProcFsConfig } from "@koi/agent-procfs";
import type { AgentRegistry, ComponentProvider, KoiMiddleware, ProcFs } from "@koi/core";
import type { KoiNode, NodeDeps } from "@koi/node";
import type { TracingConfig } from "@koi/tracing";

/**
 * Full node stack configuration — core node + optional observability subsystems.
 */
export interface NodeStackConfig {
  /** Raw node config (validated internally by createNode). */
  readonly node: unknown;
  /** Discovery provider config. Omit to disable agent discovery. */
  readonly discovery?: DiscoveryProviderConfig | undefined;
  /** ProcFs config. Omit to disable agent introspection filesystem. */
  readonly procfs?: ProcFsConfig | undefined;
  /** Tracing middleware config. Omit to disable distributed tracing. */
  readonly tracing?: TracingConfig | undefined;
}

/**
 * Full node stack dependencies — core node deps + optional registry for agent mounting.
 */
export interface NodeStackDeps extends NodeDeps {
  /** Agent registry — required for agent mounter when procfs is configured. */
  readonly registry?: AgentRegistry | undefined;
}

/**
 * Full node stack — core node + optional discovery, tracing, and procfs.
 */
export interface NodeStack {
  readonly node: KoiNode;
  readonly discoveryProvider: ComponentProvider | undefined;
  readonly tracingMiddleware: KoiMiddleware | undefined;
  readonly procFs: ProcFs | undefined;
  /** Start the node. */
  readonly start: () => Promise<void>;
  /** Stop the node and dispose all subsystems. */
  readonly stop: () => Promise<void>;
}
