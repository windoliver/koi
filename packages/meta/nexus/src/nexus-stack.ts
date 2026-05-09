import { createNexusAgentProvider } from "./agent-provider.js";
import { createGlobalBackends } from "./global-backends.js";
import type { NexusBundle, NexusStackConfig } from "./types.js";

async function runDisposers(disposers: readonly (() => void | Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(disposers.map(async (dispose) => dispose()));
  const firstFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (firstFailure !== undefined) {
    throw firstFailure.reason;
  }
}

export async function createNexusStack(config: NexusStackConfig): Promise<NexusBundle> {
  void config.transport;
  const provider = createNexusAgentProvider({
    ...config.agentProvider,
    enableScratchpad: config.enableScratchpad,
    enableWorkspace: config.enableWorkspace,
  });
  const backends = await createGlobalBackends(config.globalFactories, config.global);

  const disposers: Array<() => void | Promise<void>> = [provider.detach];
  if (config.dispose !== undefined) {
    disposers.push(...config.dispose);
  }

  return {
    backends,
    providers: [provider],
    middlewares: config.middlewares ?? [],
    config: {
      transportKind: "provided",
      scratchpadEnabled: config.enableScratchpad,
      workspaceEnabled: config.enableWorkspace,
    },
    dispose: async () => runDisposers(disposers),
  };
}
