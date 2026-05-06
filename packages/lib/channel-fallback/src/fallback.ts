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
  const wrappedSend = (message: OutboundMessage): Promise<void> => {
    const next: ContentBlock[] = [];
    for (const b of message.content) {
      const d = downgrade(b, inner.capabilities, opts);
      if (d !== null) next.push(d);
    }
    return inner.send({ ...message, content: next });
  };
  // Preserve every property of the inner adapter (including extensions
  // like sendUnsolicited) and only override send() with the
  // capability-driven downgrade pass.
  return { ...inner, send: wrappedSend } as T;
}
