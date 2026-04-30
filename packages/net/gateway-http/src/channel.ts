import type { KoiError, Result } from "@koi/core";
import type { ChannelRegistration } from "./types.js";

export interface ChannelRegistry {
  readonly register: (reg: ChannelRegistration) => Result<void, KoiError>;
  readonly get: (id: string) => ChannelRegistration | undefined;
  readonly ids: () => readonly string[];
}

export function createChannelRegistry(): ChannelRegistry {
  const map = new Map<string, ChannelRegistration>();
  return {
    register(reg) {
      if (map.has(reg.id)) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Channel "${reg.id}" already registered`,
            retryable: false,
            context: { channelId: reg.id },
          },
        };
      }
      map.set(reg.id, reg);
      return { ok: true, value: undefined };
    },
    get: (id) => map.get(id),
    ids: () => Array.from(map.keys()),
  };
}
