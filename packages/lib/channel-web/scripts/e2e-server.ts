import type { ContentBlock, InboundMessage } from "@koi/core";
import { createWebChannel } from "../src/index.js";

const TOKENS: Record<string, string> = {
  "tok-alice": "alice",
  "tok-bob": "bob",
};

const seen: Array<{ senderId: string; text: string }> = [];

const ch = createWebChannel({
  port: 0,
  authenticate: (ctx) => {
    const senderId = TOKENS[ctx.token ?? ""];
    return senderId !== undefined ? { senderId } : null;
  },
  originAllowList: ["http://localhost:3000", "https://example.com"],
  onHandlerError: (err: unknown, msg: InboundMessage): void => {
    console.error("DLQ", err, msg);
  },
});

ch.onMessage(async (msg: InboundMessage): Promise<void> => {
  const text = msg.content
    .filter(
      (b: ContentBlock): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
    )
    .map((b) => b.text)
    .join("");
  seen.push({ senderId: msg.senderId, text });
});

await ch.connect();
console.log(JSON.stringify({ port: ch.port }));

await new Promise<void>(() => {});
