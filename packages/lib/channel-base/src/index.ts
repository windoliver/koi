/**
 * @koi/channel-base — Shared channel abstraction (L0u utility).
 *
 * Provides createChannelAdapter<E>(), a generic factory that builds a complete
 * ChannelAdapter from platform-specific callbacks. Handles all shared channel
 * behavior: connection lifecycle, handler dispatch, capability-aware rendering,
 * and error isolation.
 */

export type { ChannelAdapterConfig, MessageNormalizer } from "./channel-adapter-factory.js";
export { createChannelAdapter } from "./channel-adapter-factory.js";
export type { ChannelFactory, ChannelRegistry } from "./channel-registry.js";
export { createChannelRegistry } from "./channel-registry.js";
export type {
  ConversationAddress,
  ConversationAddressStore,
} from "./conversation-address-store.js";
export { InMemoryConversationAddressStore } from "./conversation-address-store.js";
export type { ChannelErrorOutput } from "./format-error.js";
export { classifyErrorForChannel, formatErrorForChannel } from "./format-error.js";
export type { HandlerInput, HandlerWorkerOptions } from "./handler-worker.js";
export { startHandlerWorker } from "./handler-worker.js";
export type {
  IdempotencyStore,
  InMemoryIdempotencyStoreOptions,
  Lease,
  TryBeginResult,
} from "./idempotency-store.js";
export { InMemoryIdempotencyStore } from "./idempotency-store.js";
export type {
  ClaimedItem,
  DeadLetterItem,
  EnqueueResult,
  IngressQueue,
  InMemoryIngressQueueOptions,
  QueueItem,
} from "./ingress-queue.js";
export { InMemoryIngressQueue } from "./ingress-queue.js";
export type { OutboxRecord, OutboxStatus, OutboxStore } from "./outbox-store.js";
export { InMemoryOutboxStore } from "./outbox-store.js";
export type { RateLimiter, RateLimiterConfig, SendFn } from "./rate-limit.js";
export { createRateLimiter } from "./rate-limit.js";
export { renderBlocks } from "./render-blocks.js";
export type { ThreadState, ThreadStore } from "./thread-store.js";
export { InMemoryThreadStore } from "./thread-store.js";
export type { VerifyResult, WebhookIngressOptions } from "./webhook-handler.js";
export { handleWebhookIngress } from "./webhook-handler.js";
