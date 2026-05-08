declare module "@koi/core" {
  export type {
    BrickArtifact,
    ForgeDemandSignal,
    ForgeStore,
    KoiError,
    KoiMiddleware,
    StoreChangeNotifier,
  } from "../../../kernel/core/src/index.js";
}

declare module "@koi/middleware-policy-cache" {
  import type { KoiMiddleware } from "@koi/core";

  export declare function createPolicyCacheMiddleware(config?: {
    readonly notifier?: import("@koi/core").StoreChangeNotifier | undefined;
  }): PolicyCacheHandle;

  export type PolicyEntry = {
    readonly toolId: string;
    readonly brickId: string;
    readonly execute: (input: Record<string, unknown>) => unknown;
    readonly generation?: number;
    readonly scope: "agent" | "global";
    readonly agentId?: string;
  };

  export interface PolicyCacheHandle {
    readonly middleware: KoiMiddleware;
    readonly register: (
      entry: PolicyEntry,
    ) =>
      | { readonly ok: true; readonly value: undefined }
      | { readonly ok: false; readonly error: { readonly message: string } };
    readonly evict: (brickId: string) => void;
    readonly size: () => number;
    readonly dispose: () => void;
  }
}
