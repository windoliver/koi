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

export function wrapWithFallback(
  inner: ChannelAdapter,
  opts: FallbackOptions = {},
): ChannelAdapter {
  const wrapped: ChannelAdapter = {
    name: inner.name,
    capabilities: inner.capabilities,
    connect: () => inner.connect(),
    disconnect: () => inner.disconnect(),
    onMessage: (h) => inner.onMessage(h),
    send: (message: OutboundMessage) => {
      const next: ContentBlock[] = [];
      for (const b of message.content) {
        const d = downgrade(b, inner.capabilities, opts);
        if (d !== null) next.push(d);
      }
      return inner.send({ ...message, content: next });
    },
  };
  if (inner.sendStatus !== undefined) {
    const fn = inner.sendStatus;
    return { ...wrapped, sendStatus: (s) => fn(s) };
  }
  return wrapped;
}
