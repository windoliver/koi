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

  // Preserve every property of the inner adapter (including extensions
  // like sendUnsolicited) BUT also intercept known outbound entry points
  // so the downgrade pass applies uniformly. Without this, an adapter
  // method that bypasses send() (e.g. MobileChannelAdapter.sendUnsolicited)
  // would push raw unsupported blocks through a narrow channel.
  const wrapped: Record<string, unknown> = {
    ...(inner as unknown as Record<string, unknown>),
    send: wrappedSend,
  };
  // Any function-typed property whose name is a known outbound entry
  // point gets the same downgrade-then-delegate treatment. Listed
  // explicitly so a future innocuous-looking method (`onMessage`,
  // `connect`) cannot accidentally be re-typed to look like an outbound
  // and silently bypass downgrade.
  const OUTBOUND_EXTENSION_METHODS = ["sendUnsolicited"] as const;
  for (const methodName of OUTBOUND_EXTENSION_METHODS) {
    const original = (inner as unknown as Record<string, unknown>)[methodName];
    if (typeof original === "function") {
      const fn = original as (message: OutboundMessage) => Promise<void>;
      wrapped[methodName] = (message: OutboundMessage): Promise<void> =>
        fn.call(inner, downgradeMessage(message));
    }
  }
  return wrapped as T;
}
