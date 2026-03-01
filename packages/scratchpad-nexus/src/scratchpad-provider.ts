/**
 * ComponentProvider factory for @koi/scratchpad-nexus.
 *
 * Wraps ScratchpadComponent with write buffer + cache and exposes
 * write/read/list/delete as agent-facing tools via createServiceProvider.
 */

import type {
  AgentGroupId,
  AgentId,
  ComponentProvider,
  KoiMiddleware,
  ScratchpadComponent,
  TrustTier,
} from "@koi/core";
import { createServiceProvider, SCRATCHPAD } from "@koi/core";
import type { NexusClientConfig } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import type { ScratchpadOperation } from "./constants.js";
import { DEFAULT_PREFIX, OPERATIONS } from "./constants.js";
import { createGenerationCache } from "./generation-cache.js";
import { createScratchpadAdapter } from "./scratchpad-adapter.js";
import { createScratchpadClient } from "./scratchpad-client.js";
import { createDeleteTool } from "./tools/delete.js";
import { createListTool } from "./tools/list.js";
import { createReadTool } from "./tools/read.js";
import { createWriteTool } from "./tools/write.js";
import { createWriteBuffer } from "./write-buffer.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ScratchpadNexusProviderConfig {
  /** Agent ID for authoring writes. */
  readonly agentId: AgentId;
  /** Group ID for scratchpad namespace. */
  readonly groupId: AgentGroupId;
  /** Nexus JSON-RPC client configuration. */
  readonly nexus?: NexusClientConfig | undefined;
  /** Trust tier for tools. Default: "verified". */
  readonly trustTier?: TrustTier | undefined;
  /** Tool name prefix. Default: "scratchpad". */
  readonly prefix?: string | undefined;
  /** Operations to expose as tools. Default: all. */
  readonly operations?: readonly ScratchpadOperation[] | undefined;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ScratchpadNexusProviderResult {
  /** ComponentProvider for agent assembly. */
  readonly provider: ComponentProvider;
  /** Flush middleware — call flush() on turn boundaries. */
  readonly middleware: KoiMiddleware;
}

// ---------------------------------------------------------------------------
// Tool factories map
// ---------------------------------------------------------------------------

const TOOL_FACTORIES: Readonly<
  Record<
    ScratchpadOperation,
    (
      backend: ScratchpadComponent,
      prefix: string,
      tier: TrustTier,
    ) => ReturnType<typeof createWriteTool>
  >
> = {
  write: createWriteTool,
  read: createReadTool,
  list: createListTool,
  delete: createDeleteTool,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a ComponentProvider + flush middleware for scratchpad-nexus. */
export function createScratchpadNexusProvider(
  config: ScratchpadNexusProviderConfig,
): ScratchpadNexusProviderResult {
  const {
    agentId,
    groupId,
    trustTier = "verified",
    prefix = DEFAULT_PREFIX,
    operations = OPERATIONS,
  } = config;

  // Create Nexus RPC client
  const nexusConfig: NexusClientConfig = config.nexus ?? {
    baseUrl: "http://localhost:2026",
    apiKey: "",
  };
  const nexus = createNexusClient(nexusConfig);

  // Create scratchpad infrastructure
  const scratchpadClient = createScratchpadClient(nexus);
  const writeBuffer = createWriteBuffer(scratchpadClient, groupId, agentId);
  const generationCache = createGenerationCache(scratchpadClient);

  const adapter = createScratchpadAdapter({
    client: scratchpadClient,
    writeBuffer,
    generationCache,
    groupId,
    authorId: agentId,
  });

  // Create flush middleware — flushes write buffer on turn boundaries
  const middleware: KoiMiddleware = {
    name: "scratchpad-flush",
    priority: 900, // Inner layer — runs after most middleware
    describeCapabilities: () => undefined,
    onAfterTurn: async () => {
      await adapter.flush();
    },
  };

  const provider = createServiceProvider<ScratchpadComponent, ScratchpadOperation>({
    name: "scratchpad-nexus",
    singletonToken: SCRATCHPAD,
    backend: adapter,
    operations,
    factories: TOOL_FACTORIES,
    trustTier,
    prefix,
    detach: async () => {
      await adapter.flush();
      generationCache.clear();
    },
  });

  return { provider, middleware };
}
