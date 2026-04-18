/**
 * Capability registry — shared wire types and contracts for node capability
 * advertisement and tool routing.
 *
 * These types are shared between @koi/gateway and @koi/node (L2 peers that
 * cannot import each other). Placing them in L0 eliminates duplication.
 */

// ---------------------------------------------------------------------------
// Wire protocol types
// ---------------------------------------------------------------------------

/** Descriptor for a single tool advertised by a Node. */
export interface AdvertisedTool {
  readonly name: string;
  readonly description?: string | undefined;
  /** JSON Schema for the tool's arguments. */
  readonly schema?: Readonly<Record<string, unknown>> | undefined;
}

/** Capacity snapshot reported by a Node. */
export interface CapacityReport {
  readonly current: number;
  readonly max: number;
  readonly available: number;
}

/** Gateway → Node: execute a tool on this Node (may originate from a remote agent). */
export interface ToolCallPayload {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Agent requesting the tool call (for permission checks). */
  readonly callerAgentId: string;
  /** Zone scope for permission enforcement (backend-dependent). */
  readonly zone?: string | undefined;
}

/** Node → Gateway: tool execution result returned to calling agent. */
export interface ToolResultPayload {
  readonly toolName: string;
  readonly result: unknown;
}

/** Node → Gateway: tool execution failed or permission denied. */
export interface ToolErrorPayload {
  readonly toolName: string;
  readonly code: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Capability registry contract
// ---------------------------------------------------------------------------

/** A node's advertised capability set. */
export interface NodeCapability {
  readonly nodeId: string;
  readonly nodeType: "full" | "thin";
  readonly tools: readonly AdvertisedTool[];
}

/**
 * Registry of node capabilities — maps tool names to nodes that can execute them.
 *
 * L0 interface with swappable L2 backends (in-memory, distributed, etc.).
 */
export interface CapabilityRegistry {
  /** Advertise tools for a node. Replaces any previous advertisement. */
  readonly advertise: (nodeId: string, tools: readonly AdvertisedTool[]) => void | Promise<void>;
  /** Withdraw specific tools from a node's advertisement. */
  readonly withdraw: (nodeId: string, toolNames: readonly string[]) => void | Promise<void>;
  /** Resolve which nodes can execute a given tool. */
  readonly resolve: (
    toolName: string,
  ) => readonly NodeCapability[] | Promise<readonly NodeCapability[]>;
}

// ---------------------------------------------------------------------------
// Type guard (pure function on L0 types — permitted in L0)
// ---------------------------------------------------------------------------

/** Type guard — validates ToolCallPayload shape without `as` assertion. */
export function isToolCallPayload(value: unknown): value is ToolCallPayload {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.toolName === "string" &&
    obj.toolName.length > 0 &&
    typeof obj.callerAgentId === "string" &&
    obj.args !== null &&
    typeof obj.args === "object" &&
    !Array.isArray(obj.args)
  );
}
