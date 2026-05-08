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

  export interface PolicyCacheHandle {
    readonly middleware: KoiMiddleware;
    readonly register: (entry: unknown) => { readonly ok: true; readonly value: undefined };
    readonly evict: (brickId: string) => void;
    readonly size: () => number;
    readonly dispose: () => void;
  }
}
