import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  OutboundMessage,
  TextBlock,
} from "@koi/core";

export interface FallbackOptions {
  /** Prepended to file/image URLs in fallback text. */
  readonly urlPrefix?: string;
  /** If true, drop CustomBlock entirely instead of degrading to placeholder. */
  readonly dropCustom?: boolean;
}

function downgrade(
  block: ContentBlock,
  caps: ChannelCapabilities,
  opts: FallbackOptions,
): ContentBlock | null {
  switch (block.kind) {
    case "text":
      return block;
    case "image":
      if (caps.images) return block;
      return {
        kind: "text",
        text: `[image: ${block.alt ?? block.url}](${opts.urlPrefix ?? ""}${block.url})`,
      } satisfies TextBlock;
    case "file":
      if (caps.files) return block;
      return {
        kind: "text",
        text: `[file: ${block.name ?? block.url}](${opts.urlPrefix ?? ""}${block.url})`,
      } satisfies TextBlock;
    case "button":
      if (caps.buttons) return block;
      return { kind: "text", text: `[${block.label}]` } satisfies TextBlock;
    case "custom":
      if (caps.supportsA2ui) return block;
      if (opts.dropCustom === true) return null;
      return { kind: "text", text: `[custom: ${block.type}]` } satisfies TextBlock;
  }
}

/**
 * Generic over the inner adapter type so adapter-specific extension
 * methods (e.g. `MobileChannelAdapter.sendUnsolicited`) are preserved.
 * Without this, `wrapWithFallback(createMobileChannel(...))` collapsed
 * to a bare `ChannelAdapter` and stripped the only API for explicit
 * unsolicited live delivery — silently breaking welcome / resume /
 * push-to-current-client flows even though the wrapped value still
 * looked usable.
 */
export function wrapWithFallback<T extends ChannelAdapter>(
  inner: T,
  opts: FallbackOptions = {},
): T {
  const downgradeMessage = (message: OutboundMessage): OutboundMessage => {
    const next: ContentBlock[] = [];
    for (const b of message.content) {
      const d = downgrade(b, inner.capabilities, opts);
      if (d !== null) next.push(d);
    }
    return { ...message, content: next };
  };
  const wrappedSend = (message: OutboundMessage): Promise<void> =>
    inner.send(downgradeMessage(message));

  // Round-39 medium: object-spread (`{...inner, send: wrappedSend}`) only
  // copies enumerable own properties. Class-backed adapters whose lifecycle
  // methods (connect/disconnect/onMessage) live on the prototype lost
  // those methods entirely while the return type still claimed the full
  // adapter shape — silent breakage at runtime.
  //
  // Proxy delegates EVERY property access to `inner` (preserving prototype
  // chain, getters, and `this` binding) and intercepts only the known
  // outbound entry points so the downgrade pass applies uniformly.
  const OUTBOUND_EXTENSION_METHODS = new Set<string>(["sendUnsolicited"]);
  const wrapped = new Proxy(inner as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (prop === "send") return wrappedSend;
      if (typeof prop === "string" && OUTBOUND_EXTENSION_METHODS.has(prop)) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original === "function") {
          const fn = original as (message: OutboundMessage) => Promise<void>;
          return (message: OutboundMessage): Promise<void> =>
            fn.call(target, downgradeMessage(message));
        }
      }
      const value = Reflect.get(target, prop, receiver);
      // Bind methods to inner so prototype `this`-references resolve correctly.
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
  return wrapped as unknown as T;
}
