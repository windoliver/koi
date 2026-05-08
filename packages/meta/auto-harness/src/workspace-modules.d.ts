declare module "@koi/core" {
  export interface BrickArtifact {
    readonly kind: string;
    readonly id: string;
    readonly name: string;
  }

  export interface ForgeDemandSignal {
    readonly id: string;
    readonly kind: string;
    readonly trigger: {
      readonly kind: string;
      readonly toolName: string;
      readonly count: number;
    };
    readonly confidence: number;
    readonly suggestedBrickKind: string;
    readonly context: {
      readonly failureCount: number;
      readonly failedToolCalls: readonly string[];
    };
    readonly emittedAt: number;
  }

  export interface ForgeStore {
    readonly save: (...args: readonly unknown[]) => Promise<unknown>;
  }

  export interface KoiError {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  }

  export interface KoiMiddleware {
    readonly name: string;
    readonly priority?: number;
    readonly phase?: string;
    readonly describeCapabilities: (ctx: unknown) => unknown;
  }

  export interface StoreChangeNotifier {
    readonly notify: (...args: readonly unknown[]) => void;
    readonly subscribe: (...args: readonly unknown[]) => () => void;
  }
}

declare module "@koi/middleware-policy-cache" {
  import type { KoiMiddleware } from "@koi/core";

  export interface PolicyCacheHandle {
    readonly middleware: KoiMiddleware;
    readonly register: (entry: unknown) => { readonly ok: true; readonly value: undefined };
    readonly evict: (brickId: string) => void;
    readonly size: () => number;
    readonly dispose: () => void;
  }
}
